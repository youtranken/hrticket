import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { AppModule } from '../src/app.module';
import { makeUser } from './factories/user.factory';
import { categories, tickets, ticketMessages, userGroupMembership } from '../src/infra/db/schema';

/**
 * IT-REPLYPERM-001..005 — Story 12.3 (the DELIBERATE relaxation of the reply gate:
 * assignee-first → any Member/TL of the ticket's category group). Proven over real HTTP
 * (guards + service gate run only through the app, not on direct controller calls):
 *  001 — member-in-group may reply; member-out-group cannot (RLS-invisible, no leak)
 *  002 — forward follows the same widened gate
 *  003 — the OTHER gate did NOT widen: a member-in-group still can't change status (act)
 *  004 — the capability guard still wins: `ticket.reply` OFF → 403 CAPABILITY_DISABLED
 *  005 — regression: the assignee still replies; an Admin non-assignee is still refused
 * IT-COMPOSE-005 — reply-defaults is now gated exactly like sending (12.4 + 12.3).
 * Requires Docker; self-skips.
 */
describe('IT-REPLYPERM: widened reply gate enforced at the API', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let ready = false;
  let groupCat: number;
  let otherCat: number;
  let ssaCookie: string[];
  let memberInCookie: string[];
  let memberOutCookie: string[];
  let adminCookie: string[];
  let assigneeCookie: string[];
  let assigneeId = '';

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
  const makeTicket = async (
    categoryId: number,
    assignee: string | null,
    status: 'open' | 'in_progress' = 'open',
  ): Promise<string> => {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#RP${String(seq).padStart(5, '0')}`,
        subject: 'reply perm target',
        requesterEmail: 'req-rp@x.com',
        mailbox: 'hris@test.local',
        categoryId,
        status,
        assigneeId: assignee,
      })
      .returning({ id: tickets.id });
    return row!.id;
  };
  const addInbound = async (ticketId: string): Promise<string> => {
    const [m] = await harness!.db
      .insert(ticketMessages)
      .values({
        ticketId,
        direction: 'inbound',
        fromAddr: 'req-rp@x.com',
        toAddrs: ['hris@test.local'],
        bodyText: 'original',
      })
      .returning({ id: ticketMessages.id });
    return m!.id;
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
      groupCat = cats.find((c) => c.nameEn === 'Payroll')!.id;
      otherCat = cats.find((c) => c.id !== groupCat)!.id;

      const memberIn = (await makeUser(harness.db, { projectId: 1, email: 'rp-in@x.com' }))!;
      const memberOut = (await makeUser(harness.db, { projectId: 1, email: 'rp-out@x.com' }))!;
      const assignee = (await makeUser(harness.db, { projectId: 1, email: 'rp-assignee@x.com' }))!;
      assigneeId = assignee.id;
      await makeUser(harness.db, { projectId: 1, role: 'admin', email: 'rp-admin@x.com' });
      await makeUser(harness.db, { projectId: 1, role: 'ssa', email: 'rp-ssa@x.com' });
      await harness.db.insert(userGroupMembership).values([
        { userId: memberIn.id, categoryId: groupCat },
        { userId: assignee.id, categoryId: groupCat },
        { userId: memberOut.id, categoryId: otherCat },
      ]);

      ssaCookie = await loginCookie('rp-ssa@x.com');
      memberInCookie = await loginCookie('rp-in@x.com');
      memberOutCookie = await loginCookie('rp-out@x.com');
      adminCookie = await loginCookie('rp-admin@x.com');
      assigneeCookie = await loginCookie('rp-assignee@x.com');
      ready = true;
    } catch (e) {
      console.warn('[IT-REPLYPERM] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
  });

  afterEach(async () => {
    if (ready) {
      await request(server())
        .post('/api/ssa/role-capabilities/reset')
        .set('Cookie', ssaCookie)
        .expect(201);
    }
  });

  it('IT-REPLYPERM-001: member-in-group may reply; member-out-group cannot (RLS 404)', async () => {
    if (!ready) return;
    const t1 = await makeTicket(groupCat, null, 'open');
    await request(server())
      .post(`/api/tickets/${t1}/replies`)
      .set('Cookie', memberInCookie)
      .send({ to: ['someone@ext.com'], body: 'hi from group member', confirmNewRecipients: true })
      .expect(201);

    const t2 = await makeTicket(groupCat, null, 'open');
    // Out-of-group: RLS hides the ticket entirely → 404, no information leak.
    await request(server())
      .post(`/api/tickets/${t2}/replies`)
      .set('Cookie', memberOutCookie)
      .send({ to: ['someone@ext.com'], body: 'nope', confirmNewRecipients: true })
      .expect(404);
  });

  it('IT-REPLYPERM-002: forward follows the same widened gate', async () => {
    if (!ready) return;
    const t = await makeTicket(groupCat, null, 'open');
    const msgId = await addInbound(t);
    await request(server())
      .post(`/api/tickets/${t}/forward`)
      .set('Cookie', memberInCookie)
      .send({ to: ['fwd@ext.com'], ticketMessageId: msgId, confirmNewRecipients: true })
      .expect(201);

    const t2 = await makeTicket(groupCat, null, 'open');
    const msg2 = await addInbound(t2);
    await request(server())
      .post(`/api/tickets/${t2}/forward`)
      .set('Cookie', memberOutCookie)
      .send({ to: ['fwd@ext.com'], ticketMessageId: msg2, confirmNewRecipients: true })
      .expect(404);
  });

  it('IT-REPLYPERM-003: act gate did NOT widen — member-in-group still cannot change status', async () => {
    if (!ready) return;
    const t = await makeTicket(groupCat, null, 'open');
    // Reply is allowed for the group member (proven in 001) but status change is not:
    // canActOnTicket / canChangeStatus stayed assignee + TL-in-group + Admin/SSA.
    await request(server())
      .patch(`/api/tickets/${t}/status`)
      .set('Cookie', memberInCookie)
      .send({ to: 'in_progress' })
      .expect(403);
  });

  it('IT-REPLYPERM-004: capability guard still wins — ticket.reply OFF → 403 CAPABILITY_DISABLED', async () => {
    if (!ready) return;
    await setCell('member', 'ticket.reply', false);
    const t = await makeTicket(groupCat, null, 'open');
    const denied = await request(server())
      .post(`/api/tickets/${t}/replies`)
      .set('Cookie', memberInCookie)
      .send({ to: ['someone@ext.com'], body: 'blocked by cap', confirmNewRecipients: true })
      .expect(403);
    expect(denied.body.message).toBe('CAPABILITY_DISABLED');
  });

  it('IT-REPLYPERM-005: regression — assignee replies; Admin non-assignee is still refused', async () => {
    if (!ready) return;
    const t = await makeTicket(groupCat, assigneeId, 'in_progress');
    await request(server())
      .post(`/api/tickets/${t}/replies`)
      .set('Cookie', assigneeCookie)
      .send({ to: ['someone@ext.com'], body: 'assignee reply', confirmNewRecipients: true })
      .expect(201);

    const t2 = await makeTicket(groupCat, assigneeId, 'in_progress');
    const denied = await request(server())
      .post(`/api/tickets/${t2}/replies`)
      .set('Cookie', adminCookie)
      .send({ to: ['someone@ext.com'], body: 'admin should not reply', confirmNewRecipients: true })
      .expect(403);
    // Refused by the reply gate, NOT the capability guard (admin keeps ticket.reply).
    expect(denied.body.message).not.toBe('CAPABILITY_DISABLED');
  });

  it('IT-COMPOSE-005: reply-defaults is gated like sending (member-in ok, admin non-assignee 403, out-group 404)', async () => {
    if (!ready) return;
    const t = await makeTicket(groupCat, null, 'open');
    await request(server())
      .get(`/api/tickets/${t}/reply-defaults`)
      .set('Cookie', memberInCookie)
      .expect(200);
    // Admin can SEE the ticket (RLS) but is not the assignee → the reply gate refuses.
    await request(server())
      .get(`/api/tickets/${t}/reply-defaults`)
      .set('Cookie', adminCookie)
      .expect(403);
    // Out-of-group member: RLS-invisible → 404.
    await request(server())
      .get(`/api/tickets/${t}/reply-defaults`)
      .set('Cookie', memberOutCookie)
      .expect(404);
  });
});
