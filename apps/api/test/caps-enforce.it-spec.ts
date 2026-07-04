import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { AppModule } from '../src/app.module';
import { makeUser } from './factories/user.factory';
import { categories, tickets, userGroupMembership } from '../src/infra/db/schema';

/**
 * IT-CAPENF-001..003 — FR55 capability ENFORCEMENT (CapabilityGuard). The SSA
 * matrix used to drive menu visibility only; these tests prove it now gates the
 * API over real HTTP (guards don't run on direct controller calls):
 *  001 — the completed default matrix changes NOTHING vs the baseline role model
 *  002 — SSA toggles a cell OFF → that role gets 403 CAPABILITY_DISABLED on the
 *        next request (cache busted on write); toggling back ON restores access
 *  003 — the matrix editor itself stays capability-gated + locked cells hold
 * Requires Docker; self-skips.
 */
describe('IT-CAPENF: capability matrix enforced at the API', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let ready = false;
  let Payroll: number;
  let ssaCookie: string[];
  let adminCookie: string[];
  let leadCookie: string[];
  let memberCookie: string[];

  const server = () => app!.getHttpServer();
  const loginCookie = async (email: string): Promise<string[]> => {
    const res = await request(server())
      .post('/api/auth/login')
      .send({ email, password: 'test-password' })
      .expect(201);
    return res.headers['set-cookie'] as unknown as string[];
  };
  const setCell = (role: string, capability: string, allowed: boolean) =>
    request(server())
      .put('/api/ssa/role-capabilities')
      .set('Cookie', ssaCookie)
      .send({ role, capability, allowed })
      .expect(200);

  let seq = 0;
  const makePoolTicket = async (): Promise<string> => {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#C${String(seq).padStart(5, '0')}`,
        subject: 'capability enforcement target',
        requesterEmail: 'req-capenf@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: 'open',
        assigneeId: null,
      })
      .returning({ id: tickets.id });
    return row!.id;
  };

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();

      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;

      const member = (await makeUser(harness.db, { projectId: 1, email: 'capenf-m@x.com' }))!;
      const lead = (await makeUser(harness.db, { projectId: 1, role: 'team_lead', email: 'capenf-tl@x.com' }))!;
      await makeUser(harness.db, { projectId: 1, role: 'admin', email: 'capenf-a@x.com' });
      await makeUser(harness.db, { projectId: 1, role: 'ssa', email: 'capenf-s@x.com' });
      await harness.db.insert(userGroupMembership).values([
        { userId: member.id, categoryId: Payroll },
        { userId: lead.id, categoryId: Payroll },
      ]);

      ssaCookie = await loginCookie('capenf-s@x.com');
      adminCookie = await loginCookie('capenf-a@x.com');
      leadCookie = await loginCookie('capenf-tl@x.com');
      memberCookie = await loginCookie('capenf-m@x.com');
      ready = true;
    } catch (e) {
      console.warn('[IT-CAPENF] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
  });

  afterEach(async () => {
    // Every test leaves the matrix at the defaults so cases stay independent.
    if (ready) {
      await request(server())
        .post('/api/ssa/role-capabilities/reset')
        .set('Cookie', ssaCookie)
        .expect(201);
    }
  });

  it('IT-CAPENF-001: completed defaults mirror the baseline — nothing newly denied', async () => {
    if (!ready) return;
    // Admin/TL/Member keep exactly what the role model gave them.
    await request(server()).get('/api/admin/categories').set('Cookie', adminCookie).expect(200);
    await request(server()).get('/api/audit').set('Cookie', leadCookie).expect(200);
    await request(server()).get('/api/audit').set('Cookie', memberCookie).expect(403);
    await request(server()).get('/api/admin/categories').set('Cookie', memberCookie).expect(403);
    // Open-claim survives the guard: a member claims a pool ticket of their group.
    const t = await makePoolTicket();
    await request(server()).post(`/api/tickets/${t}/claim`).set('Cookie', memberCookie).send({}).expect(201);
  });

  it('IT-CAPENF-002: toggling a cell OFF blocks that role at once; ON restores it', async () => {
    if (!ready) return;
    // member · ticket.claim — the flagship FR55 case.
    await setCell('member', 'ticket.claim', false);
    const t1 = await makePoolTicket();
    const denied = await request(server())
      .post(`/api/tickets/${t1}/claim`)
      .set('Cookie', memberCookie)
      .send({})
      .expect(403);
    expect(denied.body.message).toBe('CAPABILITY_DISABLED');
    await setCell('member', 'ticket.claim', true);
    await request(server()).post(`/api/tickets/${t1}/claim`).set('Cookie', memberCookie).send({}).expect(201);

    // admin · config.manage — the whole config surface closes for Admin…
    await setCell('admin', 'config.manage', false);
    await request(server()).get('/api/admin/categories').set('Cookie', adminCookie).expect(403);
    // …while SSA still enters through the LOCKED config.manage_all cell.
    await request(server()).get('/api/admin/categories').set('Cookie', ssaCookie).expect(200);
    await setCell('admin', 'config.manage', true);
    await request(server()).get('/api/admin/categories').set('Cookie', adminCookie).expect(200);

    // team_lead · log.read_group — audit reader closes for TL.
    await setCell('team_lead', 'log.read_group', false);
    await request(server()).get('/api/audit').set('Cookie', leadCookie).expect(403);
    await setCell('team_lead', 'log.read_group', true);
    await request(server()).get('/api/audit').set('Cookie', leadCookie).expect(200);

    // admin · user.manage — the user-admin surface (lives in AuthModule) closes too.
    await setCell('admin', 'user.manage', false);
    await request(server()).get('/api/admin/users').set('Cookie', adminCookie).expect(403);
    await setCell('admin', 'user.manage', true);
    await request(server()).get('/api/admin/users').set('Cookie', adminCookie).expect(200);
  });

  it('IT-CAPENF-003: matrix editor stays gated over HTTP + locked cells refuse', async () => {
    if (!ready) return;
    // Admin lacks role.edit_capabilities → the guard blocks read AND write.
    await request(server()).get('/api/ssa/role-capabilities').set('Cookie', adminCookie).expect(403);
    await request(server())
      .put('/api/ssa/role-capabilities')
      .set('Cookie', adminCookie)
      .send({ role: 'member', capability: 'ticket.claim', allowed: false })
      .expect(403);
    // Locked anti-self-lock cells refuse even from the SSA (422, IT-ROLECAP-002 over HTTP).
    await request(server())
      .put('/api/ssa/role-capabilities')
      .set('Cookie', ssaCookie)
      .send({ role: 'ssa', capability: 'role.edit_capabilities', allowed: false })
      .expect(422);
    // The ENTIRE SSA column is locked ON (owner's call 4/7/2026) — a ticket cell too.
    await request(server())
      .put('/api/ssa/role-capabilities')
      .set('Cookie', ssaCookie)
      .send({ role: 'ssa', capability: 'ticket.reply', allowed: false })
      .expect(422);
    // Dead (non-applicable) cells are locked OFF — granting refuses too.
    await request(server())
      .put('/api/ssa/role-capabilities')
      .set('Cookie', ssaCookie)
      .send({ role: 'member', capability: 'user.manage', allowed: true })
      .expect(422);
    const matrix = await request(server())
      .get('/api/ssa/role-capabilities')
      .set('Cookie', ssaCookie)
      .expect(200);
    type Cell = { role: string; allowed: boolean; locked: boolean };
    const rows = matrix.body.rows as Array<{ capability: string; cells: Cell[] }>;
    for (const row of rows) {
      const ssaCell = row.cells.find((c) => c.role === 'ssa')!;
      expect(ssaCell).toMatchObject({ allowed: true, locked: true });
    }
    const memberUserManage = rows
      .find((r) => r.capability === 'user.manage')!
      .cells.find((c) => c.role === 'member')!;
    expect(memberUserManage).toMatchObject({ allowed: false, locked: true });
  });
});
