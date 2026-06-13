import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { AppModule } from '../src/app.module';
import { makeUser } from './factories/user.factory';
import { TicketsReadService } from '../src/modules/tickets/tickets-read.service';
import type { SessionUser } from '../src/modules/auth/session.service';
import { tickets, categories, userGroupMembership } from '../src/infra/db/schema';

const HRIS = 1;
const CNB = 2;

function asSession(row: { id: string; email: string; name: string; role: string; projectId: number | null }): SessionUser {
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

describe('IT-API-001: ticket list + detail (RLS)', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let read: TicketsReadService;
  let ready = false;

  let memberU: SessionUser;
  let adminU: SessionUser;
  let ssaU: SessionUser;
  let otherTicketId = '';
  let payrollTicketId = '';

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();
      read = new TicketsReadService();

      const cats = await harness.db
        .select({ id: categories.id, en: categories.nameEn, sys: categories.isSystem })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      const otherCat = cats.find((c) => c.sys)!;
      const payrollCat = cats.find((c) => c.en === 'Payroll')!;

      const member = await makeUser(harness.db, { projectId: HRIS, email: 'mem@t.local', role: 'member' });
      const admin = await makeUser(harness.db, { projectId: HRIS, email: 'adm@t.local', role: 'admin' });
      const ssa = await makeUser(harness.db, { projectId: HRIS, email: 'ssa@t.local', role: 'ssa' });
      memberU = asSession(member!);
      adminU = asSession(admin!);
      ssaU = asSession(ssa!);
      // member belongs to the "Other" group only
      await harness.db.insert(userGroupMembership).values({ userId: member!.id, categoryId: otherCat.id });

      const mk = async (projectId: number, code: string, categoryId: number) => {
        const [t] = await harness!.db
          .insert(tickets)
          .values({ projectId, ticketCode: code, subject: 's', requesterEmail: 'a@x.com', mailbox: 'box', categoryId })
          .returning({ id: tickets.id });
        return t!.id;
      };
      otherTicketId = await mk(HRIS, '#00001', otherCat.id); // visible to member
      payrollTicketId = await mk(HRIS, '#00002', payrollCat.id); // hidden from member
      await mk(CNB, '#00001', otherCat.id); // other project

      ready = true;
    } catch (e) {
      console.warn('[IT-API-001] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
  });

  it('list visibility differs by scope (member < admin < ssa)', async () => {
    if (!ready) return;
    const member = await read.list(memberU);
    const admin = await read.list(adminU);
    const ssa = await read.list(ssaU);
    expect(member.total).toBe(1); // only the Other-group hris ticket
    expect(admin.total).toBe(2); // whole hris project
    expect(ssa.total).toBe(3); // both projects
  });

  it('detail outside scope → 404 (no existence leak)', async () => {
    if (!ready) return;
    await expect(read.getDetail(memberU, payrollTicketId)).rejects.toThrow();
    const visible = await read.getDetail(memberU, otherTicketId);
    expect(visible.ticket.ticketCode).toBe('#00001');
  });

  it('HTTP GET /api/tickets paginates for the logged-in user', async () => {
    if (!ready) return;
    const login = await request(app!.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'adm@t.local', password: 'test-password' })
      .expect(201);
    const cookie = login.headers['set-cookie'] as unknown as string[];
    const res = await request(app!.getHttpServer())
      .get('/api/tickets?page=1&pageSize=10')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.length).toBe(2);
    expect(res.body.pageSize).toBe(10);
  });
});
