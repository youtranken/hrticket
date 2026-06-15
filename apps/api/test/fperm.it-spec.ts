import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { AppModule } from '../src/app.module';
import { FilesService } from '../src/modules/files/files.service';
import { TicketsReadService } from '../src/modules/tickets/tickets-read.service';
import { signFileToken } from '../src/infra/crypto/signed-url';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { storagePathFor, writeFile } from '../src/infra/storage/fs-storage';
import { makeUser } from './factories/user.factory';
import {
  tickets,
  attachments,
  categories,
  userGroupMembership,
  viewLog,
} from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';

const HRIS = 1;
const CNB = 2;
const PDF = Buffer.from('%PDF-1.4\n payslip \n%%EOF\n', 'latin1');

function asSession(row: {
  id: string;
  email: string;
  name: string;
  role: string;
  projectId: number | null;
}): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as SessionUser['role'],
    projectId: row.projectId,
    disabled: false,
    mustChangePassword: false,
  };
}

/**
 * IT-FPERM-001..003 — Story 8.3. access-url permission inherits ticket visibility,
 * sensitive-category view-log + 5-min dedup, and the no-static-path guarantee.
 * Needs Docker; self-skips.
 */
describe('IT-FPERM: file permission + view-log', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let ready = false;
  let storageRoot = '';
  const files = new FilesService();
  const read = new TicketsReadService();

  // Category ids
  let payrollCat = 0; // sensitive
  let leaveCat = 0; // NOT sensitive
  let otherCat = 0; // system "Other"

  // Users (sessions)
  let payrollMember: SessionUser; // in Payroll group → sees Payroll tickets
  let otherMember: SessionUser; // only in "Other" group → cannot see Payroll
  let admin: SessionUser; // same project → sees all
  let ssa: SessionUser; // sees both projects
  let cnbUser: SessionUser; // other project → cannot see HRIS ticket

  // Attachments
  let sensAttId = ''; // on a sensitive Payroll ticket
  let sensTicketId = '';
  let normalAttId = ''; // on a non-sensitive Leave ticket
  let normalTicketId = '';

  const server = () => app!.getHttpServer();
  const loginCookie = async (email: string): Promise<string[]> => {
    const res = await request(server())
      .post('/api/auth/login')
      .send({ email, password: 'test-password' })
      .expect(201);
    return res.headers['set-cookie'] as unknown as string[];
  };

  const mkTicket = async (
    projectId: number,
    code: string,
    categoryId: number,
  ): Promise<string> =>
    withActor(systemActor, async (tx) => {
      const [t] = await tx
        .insert(tickets)
        .values({
          projectId,
          ticketCode: code,
          subject: 's',
          requesterEmail: 'a@x.com',
          mailbox: 'box',
          status: 'open',
          categoryId,
        })
        .returning({ id: tickets.id });
      return t!.id;
    });

  const mkAttachment = async (ticketId: string, projectId: number): Promise<string> => {
    const when = new Date();
    const rel = storagePathFor(projectId, `fperm-${Math.random().toString(36).slice(2)}`, when);
    await writeFile(rel, PDF);
    return withActor(systemActor, async (tx) => {
      const [a] = await tx
        .insert(attachments)
        .values({
          ticketId,
          fileName: 'payslip.pdf',
          mimeType: 'application/pdf',
          size: PDF.length,
          storagePath: rel,
          status: 'stored',
        })
        .returning({ id: attachments.id });
      return a!.id;
    });
  };

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hris-fperm-'));
    process.env.ATTACHMENT_STORAGE_ROOT = storageRoot;
    try {
      harness = await startHarness({ seed: true });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();

      const cats = await harness.db
        .select({ id: categories.id, en: categories.nameEn, sys: categories.isSystem })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      payrollCat = cats.find((c) => c.en === 'Payroll')!.id;
      leaveCat = cats.find((c) => c.en === 'Leave')!.id;
      otherCat = cats.find((c) => c.sys)!.id;
      // Flag Payroll sensitive (Leave stays normal).
      await harness.db
        .update(categories)
        .set({ isSensitive: true })
        .where(eq(categories.id, payrollCat));

      const pm = await makeUser(harness.db, { projectId: HRIS, email: 'pm@t.local', role: 'member' });
      const om = await makeUser(harness.db, { projectId: HRIS, email: 'om@t.local', role: 'member' });
      const ad = await makeUser(harness.db, { projectId: HRIS, email: 'ad@t.local', role: 'admin' });
      const sa = await makeUser(harness.db, { projectId: HRIS, email: 'sa@t.local', role: 'ssa' });
      const cb = await makeUser(harness.db, { projectId: CNB, email: 'cb@t.local', role: 'member' });
      payrollMember = asSession(pm!);
      otherMember = asSession(om!);
      admin = asSession(ad!);
      ssa = asSession(sa!);
      cnbUser = asSession(cb!);

      await harness.db.insert(userGroupMembership).values([
        { userId: pm!.id, categoryId: payrollCat }, // sees Payroll
        { userId: om!.id, categoryId: otherCat }, // sees only Other
      ]);

      sensTicketId = await mkTicket(HRIS, '#08300', payrollCat);
      sensAttId = await mkAttachment(sensTicketId, HRIS);
      normalTicketId = await mkTicket(HRIS, '#08301', leaveCat);
      normalAttId = await mkAttachment(normalTicketId, HRIS);

      ready = true;
    } catch (e) {
      console.warn('[IT-FPERM] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
    if (storageRoot) await fs.rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (ready) await harness!.db.delete(viewLog);
  });

  // ── IT-FPERM-001 — permission matrix ────────────────────────────────────────
  it('IT-FPERM-001: access-url visibility = ticket visibility (5-way matrix)', async () => {
    if (!ready) return;
    // Payroll-group member → OK
    await expect(files.mintAccessUrl(payrollMember, sensAttId)).resolves.toMatchObject({
      url: expect.stringContaining(sensAttId),
    });
    // Member of a different group → 404 (no existence leak)
    await expect(files.mintAccessUrl(otherMember, sensAttId)).rejects.toMatchObject({ status: 404 });
    // Admin same project → OK
    await expect(files.mintAccessUrl(admin, sensAttId)).resolves.toMatchObject({
      url: expect.stringContaining(sensAttId),
    });
    // SSA → OK
    await expect(files.mintAccessUrl(ssa, sensAttId)).resolves.toBeTruthy();
    // User of the other project → 404
    await expect(files.mintAccessUrl(cnbUser, sensAttId)).rejects.toMatchObject({ status: 404 });
  });

  // ── IT-FPERM-002 — view-log on sensitive only ───────────────────────────────
  it('IT-FPERM-002: sensitive download logs file_download; normal logs nothing', async () => {
    if (!ready) return;
    await files.mintAccessUrl(payrollMember, sensAttId);
    const fileRows = await harness!.db
      .select()
      .from(viewLog)
      .where(eq(viewLog.action, 'file_download'));
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]!.actorId).toBe(payrollMember.id);
    expect(fileRows[0]!.attachmentId).toBe(sensAttId);
    expect(fileRows[0]!.ticketId).toBe(sensTicketId);

    // A non-sensitive ticket's download is NOT logged.
    await files.mintAccessUrl(admin, normalAttId);
    const afterNormal = await harness!.db.select().from(viewLog);
    expect(afterNormal).toHaveLength(1); // unchanged
  });

  it('IT-FPERM-002: opening a sensitive ticket logs ticket_view; a normal ticket does not', async () => {
    if (!ready) return;
    // Reading the SENSITIVE ticket detail records ticket_view (server-side, via the
    // getDetail() hook) with the right shape.
    await read.getDetail(payrollMember, sensTicketId);
    const rows = await harness!.db.select().from(viewLog).where(eq(viewLog.action, 'ticket_view'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(payrollMember.id);
    expect(rows[0]!.ticketId).toBe(sensTicketId);
    expect(rows[0]!.attachmentId).toBeNull();

    // Reading a NON-sensitive (Leave) ticket logs nothing.
    await read.getDetail(admin, normalTicketId);
    const after = await harness!.db.select().from(viewLog).where(eq(viewLog.action, 'ticket_view'));
    expect(after).toHaveLength(1); // unchanged
  });

  // ── IT-FPERM-003 — dedup + no static path ───────────────────────────────────
  it('IT-FPERM-003: many downloads in 5 min = 1 row; after 5 min = a 2nd row', async () => {
    if (!ready) return;
    // A player asks for many Range chunks → many mints in quick succession.
    for (let i = 0; i < 5; i++) await files.mintAccessUrl(payrollMember, sensAttId);
    let rows = await harness!.db.select().from(viewLog).where(eq(viewLog.action, 'file_download'));
    expect(rows).toHaveLength(1);

    // Backdate the one row past the 5-min window → the next mint writes a fresh row.
    await harness!.db
      .update(viewLog)
      .set({ createdAt: sql`now() - interval '6 minutes'` })
      .where(eq(viewLog.id, rows[0]!.id));
    await files.mintAccessUrl(payrollMember, sensAttId);
    rows = await harness!.db.select().from(viewLog).where(eq(viewLog.action, 'file_download'));
    expect(rows).toHaveLength(2);
  });

  it('IT-FPERM-003: no static path — only a valid sig+session+RLS serves bytes (AC4)', async () => {
    if (!ready) return;
    const cookie = await loginCookie('pm@t.local');

    // (a) No token → 403 (the only file route requires a signed token).
    await request(server()).get(`/api/files/${sensAttId}`).set('Cookie', cookie).expect(403);

    // (b) A token for a DIFFERENT attachment → 403 (sig is bound to the id).
    const wrongSig = signFileToken('11111111-1111-1111-1111-111111111111', payrollMember.id);
    await request(server())
      .get(`/api/files/${sensAttId}`)
      .query({ token: wrongSig })
      .set('Cookie', cookie)
      .expect(403);

    // (c) A guessable static-looking path is NOT served by the app (no such route).
    await request(server()).get(`/attachments/${sensAttId}`).set('Cookie', cookie).expect(404);

    // (d) The ONLY way through: a valid sig minted for this user + ticket visibility.
    const goodSig = signFileToken(sensAttId, payrollMember.id);
    await request(server())
      .get(`/api/files/${sensAttId}`)
      .query({ token: goodSig })
      .set('Cookie', cookie)
      .expect(200);
  });
});
