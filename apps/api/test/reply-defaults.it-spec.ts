import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { tickets, ticketMessages, participants } from '../src/infra/db/schema';
import { ReplyService } from '../src/modules/tickets/reply.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const session = (id: string, email: string, role: SessionUser['role'], projectId: number | null): SessionUser => ({
  id,
  email,
  name: email,
  role,
  projectId,
  disabled: false,
  mustChangePassword: false,
});

/**
 * IT-COMPOSE-001..003 — Story 12.4. Reply/Reply-All recipients come from the specific
 * message the user acted on (messageId), not always the latest mail; `mode=reply`
 * narrows to that message's sender only. Needs Docker.
 */
describe('IT-COMPOSE: per-message reply defaults', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new ReplyService();
  let ADMIN: SessionUser;
  let ticketId = '';
  let midOld = '';
  let midNew = '';

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const a = (await makeUser(harness.db, { projectId: 1, email: 'adm-rd@x.com', role: 'admin' }))!;
      ADMIN = session(a.id, a.email, 'admin', 1);

      const [tk] = await harness.db
        .insert(tickets)
        .values({
          projectId: 1,
          ticketCode: '#RD001',
          subject: 'reply defaults',
          requesterEmail: 'alice@ext.com',
          mailbox: 'hris@test.local',
          status: 'in_progress',
          assigneeId: a.id,
        })
        .returning({ id: tickets.id });
      ticketId = tk!.id;

      // Older inbound: sender alice, cc [carol, dave].
      const [m1] = await harness.db
        .insert(ticketMessages)
        .values({
          ticketId,
          direction: 'inbound',
          fromAddr: 'alice@ext.com',
          toAddrs: ['hris@test.local'],
          ccAddrs: ['carol@ext.com', 'dave@ext.com'],
          createdAt: new Date(Date.now() - 2 * 86_400_000),
        })
        .returning({ id: ticketMessages.id });
      midOld = m1!.id;

      // Newer inbound: sender erin, cc [frank] — the "latest" mail.
      const [m2] = await harness.db
        .insert(ticketMessages)
        .values({
          ticketId,
          direction: 'inbound',
          fromAddr: 'erin@ext.com',
          toAddrs: ['hris@test.local'],
          ccAddrs: ['frank@ext.com'],
          createdAt: new Date(Date.now() - 1 * 86_400_000),
        })
        .returning({ id: ticketMessages.id });
      midNew = m2!.id;

      ready = true;
    } catch (e) {
      console.warn('[IT-COMPOSE] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  it('IT-COMPOSE-001: Reply-All on a specific (older) message uses THAT message audience', async () => {
    if (!ready) return;
    const d = await svc.getDefaults(ADMIN, ticketId, { messageId: midOld, mode: 'replyAll' });
    expect(d.to).toContain('alice@ext.com');
    expect(d.cc.sort()).toEqual(['carol@ext.com', 'dave@ext.com']);
    expect(d.cc).not.toContain('frank@ext.com'); // not the latest message's cc
  });

  it('IT-COMPOSE-002: Reply (not all) on a message = its sender only, no cc', async () => {
    if (!ready) return;
    const d = await svc.getDefaults(ADMIN, ticketId, { messageId: midOld, mode: 'reply' });
    expect(d.to).toEqual(['alice@ext.com']);
    expect(d.cc).toEqual([]);
  });

  it('IT-COMPOSE-003: no messageId → latest mail (regression with 3.2)', async () => {
    if (!ready) return;
    const d = await svc.getDefaults(ADMIN, ticketId);
    expect(d.to).toContain('erin@ext.com');
    expect(d.cc).toEqual(['frank@ext.com']);
    expect(midNew).toBeTruthy();
  });

  it('IT-COMPOSE-004: keep filter drops own mailbox + rejected; empty audience → requester fallback', async () => {
    if (!ready) return;
    // A message that carries our OWN mailbox on To and a REJECTED participant on Cc.
    const [m3] = await harness!.db
      .insert(ticketMessages)
      .values({
        ticketId,
        direction: 'inbound',
        fromAddr: 'grace@ext.com',
        toAddrs: ['hris@test.local', 'henry@ext.com'],
        ccAddrs: ['rejectme@ext.com', 'ivan@ext.com'],
        createdAt: new Date(),
      })
      .returning({ id: ticketMessages.id });
    await harness!.db
      .insert(participants)
      .values({ ticketId, email: 'rejectme@ext.com', status: 'rejected' });

    const d = await svc.getDefaults(ADMIN, ticketId, { messageId: m3!.id, mode: 'replyAll' });
    expect(d.to).toEqual(expect.arrayContaining(['grace@ext.com', 'henry@ext.com']));
    expect(d.to).not.toContain('hris@test.local'); // own mailbox dropped
    expect(d.cc).toContain('ivan@ext.com');
    expect(d.cc).not.toContain('rejectme@ext.com'); // rejected never re-enters

    // A message whose only address IS our mailbox → audience empties → fallback to requester.
    const [m4] = await harness!.db
      .insert(ticketMessages)
      .values({
        ticketId,
        direction: 'inbound',
        fromAddr: 'hris@test.local',
        toAddrs: ['hris@test.local'],
        ccAddrs: [],
        createdAt: new Date(),
      })
      .returning({ id: ticketMessages.id });
    const d2 = await svc.getDefaults(ADMIN, ticketId, { messageId: m4!.id, mode: 'replyAll' });
    expect(d2.to).toEqual(['alice@ext.com']); // requester fallback (ticket requesterEmail)
  });
});
