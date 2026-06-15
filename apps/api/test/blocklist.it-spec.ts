import { and, eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { makeRaw, seedInbox } from './helpers/mail-raw';
import { IntakeService } from '../src/modules/intake/intake.service';
import { AdminBlocklistService } from '../src/modules/admin/admin-blocklist.service';
import {
  inboxMessages,
  tickets,
  ticketMessages,
  participants,
  projectCounters,
  blocklist,
  outbox,
} from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';

/**
 * IT-BLOCK-001/002 — Story 7.1 (FR100). A blocked sender's NEW-ticket mail never
 * becomes a ticket (no ack) but is kept as `blocked` + audited (NFR8). Per-project
 * scope, unblock recovers, and an existing participant's in-thread reply is never cut.
 */
describe('IT-BLOCK: sender blocklist', () => {
  let harness: ItHarness | undefined;
  let intake: IntakeService;
  let ready = false;
  const svc = new AdminBlocklistService();
  const HRIS = 1;
  const CNB = 2;
  const HRIS_BOX = 'hris@test.local';
  const CNB_BOX = 'cnb@test.local';
  const admin: SessionUser = {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'block-admin@x.com',
    name: 'block admin',
    role: 'admin',
    projectId: HRIS,
    disabled: false,
    mustChangePassword: false,
  };

  const tall = () => harness!.db.select().from(tickets);

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const realAdmin = (await makeUser(harness.db, { projectId: HRIS, role: 'admin', email: 'block-admin@x.com' }))!;
      admin.id = realAdmin.id;
      intake = new IntakeService();
      ready = true;
    } catch (e) {
      console.warn('[IT-BLOCK] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(participants);
      await harness!.db.delete(ticketMessages);
      await harness!.db.delete(inboxMessages);
      await harness!.db.delete(outbox);
      await harness!.db.delete(tickets);
      await harness!.db.delete(blocklist);
      await harness!.db.execute(sql`DELETE FROM audit_log WHERE action LIKE 'inbox.%' OR action LIKE 'blocklist.%'`);
      await harness!.db.update(projectCounters).set({ lastNo: 0 });
    }
  });

  const blockedAudits = async (projectId: number, email: string): Promise<number> => {
    const rows = (await harness!.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'inbox.blocked' AND project_id = ${projectId}
        AND lower(new_value->>'from') = lower(${email})
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  };

  it('IT-BLOCK-001: blocked sender → no ticket/ack, kept+audited; per-project; unblock recovers', async () => {
    if (!ready) return;

    // Admin blocks spam@x.com in HRIS only (exercises the admin CRUD path + audit).
    await svc.add(admin, HRIS, { email: 'spam@x.com', reason: 'harassment' });

    // New mail from the blocked sender into the HRIS mailbox.
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'spam@x.com', to: HRIS_BOX, subject: 'Buy now', messageId: '<b1@x.com>' }), '<b1@x.com>');
    // Same sender into the CNB mailbox (DIFFERENT project) — must NOT be blocked (AC2).
    await seedInbox(harness!.db, CNB, CNB_BOX, makeRaw({ from: 'spam@x.com', to: CNB_BOX, subject: 'Hello CNB', messageId: '<b2@x.com>' }), '<b2@x.com>');

    await intake.processReceived();

    // HRIS: no ticket, inbox row blocked, no auto-ack, audit present (AC1 + NFR8).
    const hrisTickets = await harness!.db.select().from(tickets).where(eq(tickets.projectId, HRIS));
    expect(hrisTickets).toHaveLength(0);
    const blockedRow = (await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.messageId, '<b1@x.com>')))[0]!;
    expect(blockedRow.status).toBe('blocked');
    expect(blockedRow.ticketId).toBeNull();
    // No auto-ack for the blocked mail: nothing enqueued in the HRIS project (the CNB
    // ticket below legitimately produces its own ack in project 2).
    expect(await harness!.db.select().from(outbox).where(eq(outbox.projectId, HRIS))).toHaveLength(0);
    expect(await blockedAudits(HRIS, 'spam@x.com')).toBe(1);

    // CNB: ticket created normally (per-project isolation, AC2).
    const cnbTickets = await harness!.db.select().from(tickets).where(eq(tickets.projectId, CNB));
    expect(cnbTickets).toHaveLength(1);
    const cnbInbox = (await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.messageId, '<b2@x.com>')))[0]!;
    expect(cnbInbox.status).toBe('processed');

    // blockedCount surfaced by the admin list view (audit-derived).
    const list = await svc.list(admin, HRIS);
    expect(list.find((e) => e.email === 'spam@x.com')?.blockedCount).toBe(1);

    // Unblock → next mail from the same sender creates a ticket (AC4).
    const id = list.find((e) => e.email === 'spam@x.com')!.id;
    await svc.remove(admin, HRIS, id);
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'spam@x.com', to: HRIS_BOX, subject: 'After unblock', messageId: '<b3@x.com>' }), '<b3@x.com>');
    await intake.processReceived();
    const after = (await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.messageId, '<b3@x.com>')))[0]!;
    expect(after.status).toBe('processed');
    expect(await harness!.db.select().from(tickets).where(eq(tickets.projectId, HRIS))).toHaveLength(1);
  });

  it('IT-BLOCK-002: an existing participant blocked later still threads in-reply', async () => {
    if (!ready) return;

    // p@x.com starts a legit thread → becomes a participant.
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'p@x.com', to: HRIS_BOX, subject: 'Original', messageId: '<orig@x.com>' }), '<orig@x.com>');
    await intake.processReceived();
    const [t] = await tall();
    expect(t).toBeDefined();

    // Now p is blocked.
    await svc.add(admin, HRIS, { email: 'p@x.com', reason: 'later' });

    // p replies IN-THREAD (In-Reply-To matches) → must append, NOT be blocked (AC3).
    await seedInbox(
      harness!.db,
      HRIS,
      HRIS_BOX,
      makeRaw({ from: 'p@x.com', to: HRIS_BOX, subject: 'Re: Original', messageId: '<reply@x.com>', inReplyTo: '<orig@x.com>' }),
      '<reply@x.com>',
    );
    await intake.processReceived();

    expect(await tall()).toHaveLength(1); // no new ticket
    const replyRow = (await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.messageId, '<reply@x.com>')))[0]!;
    expect(replyRow.status).toBe('processed'); // appended, not blocked
    const inboundMsgs = await harness!.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, t!.id), eq(ticketMessages.direction, 'inbound')));
    expect(inboundMsgs).toHaveLength(2); // original + reply
    expect(await blockedAudits(HRIS, 'p@x.com')).toBe(0); // never blocked
  });
});
