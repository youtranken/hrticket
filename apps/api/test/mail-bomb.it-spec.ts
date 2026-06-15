import { and, eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { makeRaw, seedInbox } from './helpers/mail-raw';
import { IntakeService } from '../src/modules/intake/intake.service';
import { AdminMailBombService } from '../src/modules/admin/admin-mailbomb.service';
import {
  inboxMessages,
  tickets,
  ticketMessages,
  participants,
  projectCounters,
  projectSettings,
  mailBombCounters,
  mailBombAlertLog,
  notifications,
  outbox,
} from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';

/**
 * IT-BOMB-001/002/003 — Story 7.2 (FR101). A sender over the per-project hourly
 * threshold has the surplus mails SUPPRESSED (kept + releasable, NFR8) with exactly
 * one grouped Admin alert; "reprocess" releases a held mail back through the pipeline;
 * the sliding window resets and a threshold change is effective immediately.
 */
describe('IT-BOMB: mail-bomb suppression + release', () => {
  let harness: ItHarness | undefined;
  let intake: IntakeService;
  let ready = false;
  const svc = new AdminMailBombService();
  const HRIS = 1;
  const HRIS_BOX = 'hris@test.local';
  const admin: SessionUser = {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'bomb-admin@x.com',
    name: 'bomb admin',
    role: 'admin',
    projectId: HRIS,
    disabled: false,
    mustChangePassword: false,
  };

  const setThreshold = (n: number) =>
    harness!.db.update(projectSettings).set({ mailBombPerHour: n }).where(eq(projectSettings.projectId, HRIS));

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const realAdmin = (await makeUser(harness.db, { projectId: HRIS, role: 'admin', email: 'bomb-admin@x.com' }))!;
      admin.id = realAdmin.id;
      intake = new IntakeService();
      ready = true;
    } catch (e) {
      console.warn('[IT-BOMB] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(participants);
      await harness!.db.delete(ticketMessages);
      await harness!.db.delete(notifications);
      await harness!.db.delete(inboxMessages);
      await harness!.db.delete(outbox);
      await harness!.db.delete(tickets);
      await harness!.db.delete(mailBombCounters);
      await harness!.db.delete(mailBombAlertLog);
      await harness!.db.execute(sql`DELETE FROM audit_log WHERE action LIKE 'mail_bomb%' OR action LIKE 'inbox.%'`);
      await harness!.db.update(projectCounters).set({ lastNo: 0 });
      await setThreshold(20);
    }
  });

  const seedN = async (sender: string, n: number, prefix: string) => {
    for (let i = 1; i <= n; i++) {
      const mid = `<${prefix}-${i}@x.com>`;
      await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: sender, to: HRIS_BOX, subject: `S${i}`, messageId: mid }), mid);
    }
  };

  it('IT-BOMB-001: 25 mails over threshold 20 → 20 tickets + 5 suppressed + 1 grouped alert', async () => {
    if (!ready) return;
    await seedN('flood@x.com', 25, 'b1');
    // Process the whole batch (maxBatch covers 25).
    await intake.processReceived(60);

    const tix = await harness!.db.select().from(tickets).where(eq(tickets.projectId, HRIS));
    expect(tix).toHaveLength(20); // first 20 created

    const inbox = await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.projectId, HRIS));
    expect(inbox).toHaveLength(25); // none lost (NFR8)
    const suppressed = inbox.filter((r) => r.status === 'suppressed');
    const processed = inbox.filter((r) => r.status === 'processed');
    expect(suppressed).toHaveLength(5);
    expect(processed).toHaveLength(20);

    // Exactly ONE grouped alert per (sender, window): one alert_log row, one+ notifications
    // to the admin, and one alert email enqueued (subject names the sender).
    const alertRows = await harness!.db.select().from(mailBombAlertLog).where(eq(mailBombAlertLog.projectId, HRIS));
    expect(alertRows).toHaveLength(1);
    // One alert per recipient admin/ssa — the admin is among them, and each fired once
    // (no double-alert in the window). The single alert_log row above is the real dedup.
    const notes = await harness!.db.select().from(notifications).where(eq(notifications.type, 'mail_bomb'));
    expect(notes.some((n) => n.actorId === admin.id)).toBe(true);
    expect(notes.filter((n) => n.actorId === admin.id)).toHaveLength(1); // admin alerted exactly once
    const alertMails = (await harness!.db.select().from(outbox)).filter((o) => o.subject.includes('flood@x.com'));
    expect(alertMails).toHaveLength(1); // exactly one grouped email
  });

  it('IT-BOMB-002: reprocess releases a held mail — plain → ticket+ack; reply → append', async () => {
    if (!ready) return;
    await setThreshold(1); // 1 created, rest suppressed — easy to make held mails

    // First a legit thread starter (becomes ticket #... and a participant).
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'p@x.com', to: HRIS_BOX, subject: 'Orig', messageId: '<orig@x.com>' }), '<orig@x.com>');
    await intake.processReceived();
    const [t0] = await harness!.db.select().from(tickets);
    expect(t0).toBeDefined();

    // Now flood from a DIFFERENT sender so we get suppressed PLAIN mails.
    await seedN('flood@x.com', 3, 'b2'); // threshold 1 → 1 created, 2 suppressed
    await intake.processReceived(30);
    const suppressed = (await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.status, 'suppressed')));
    expect(suppressed.length).toBeGreaterThanOrEqual(2);
    const plainHeld = suppressed[0]!;

    // A held mail that happens to be a REPLY to the existing thread. In the live
    // pipeline a thread-matching reply is never suppressed (M6 exception — the mail-bomb
    // gate only runs on the create branch), so to exercise reprocess outcome (b) we seed
    // the row directly as `suppressed` (its In-Reply-To references the thread root).
    const repId = await seedInbox(
      harness!.db,
      HRIS,
      HRIS_BOX,
      makeRaw({ from: 'p@x.com', to: HRIS_BOX, subject: 'Re: Orig', messageId: '<rep@x.com>', inReplyTo: '<orig@x.com>' }),
      '<rep@x.com>',
    );
    await harness!.db.update(inboxMessages).set({ status: 'suppressed' }).where(eq(inboxMessages.id, repId));

    const ticketsBefore = (await harness!.db.select().from(tickets)).length;
    const outboxBefore = (await harness!.db.select().from(outbox)).length;

    // Release the PLAIN held mail → new ticket + auto-ack (outcome a).
    const r1 = await svc.reprocess(admin, HRIS, plainHeld.id);
    expect(r1.outcome).toBe('ticket_created');
    expect((await harness!.db.select().from(tickets)).length).toBe(ticketsBefore + 1);
    expect((await harness!.db.select().from(outbox)).length).toBeGreaterThan(outboxBefore); // ack enqueued
    const plainRow = (await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.id, plainHeld.id)))[0]!;
    expect(plainRow.status).toBe('processed');

    // Release the held REPLY → appends to the existing thread, NO new ticket, NO ack.
    const repHeld = (await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.messageId, '<rep@x.com>')))[0]!;
    expect(repHeld.status).toBe('suppressed');
    const ticketsBefore2 = (await harness!.db.select().from(tickets)).length;
    const outboxBefore2 = (await harness!.db.select().from(outbox)).length;
    const r2 = await svc.reprocess(admin, HRIS, repHeld.id);
    expect(r2.outcome).toBe('appended');
    expect((await harness!.db.select().from(tickets)).length).toBe(ticketsBefore2); // no new ticket
    expect((await harness!.db.select().from(outbox)).length).toBe(outboxBefore2); // no ack
    const inboundOnT0 = await harness!.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, t0!.id), eq(ticketMessages.direction, 'inbound')));
    expect(inboundOnT0.length).toBe(2); // orig + released reply
  });

  it('IT-BOMB-003: sliding window resets next hour; threshold change effective immediately', async () => {
    if (!ready) return;

    // AC4: threshold 20 → 5; 8 mails from one sender → 5 created, 3 suppressed.
    await svc.putConfig(admin, HRIS, 5);
    await seedN('cfg@x.com', 8, 'b3');
    await intake.processReceived(30);
    const inbox = await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.projectId, HRIS));
    expect(inbox.filter((r) => r.status === 'processed')).toHaveLength(5);
    expect(inbox.filter((r) => r.status === 'suppressed')).toHaveLength(3);

    // AC3: backdate the sender's window so the next mail lands in a FRESH window → created.
    await harness!.db
      .update(mailBombCounters)
      .set({ windowStart: sql`date_trunc('hour', now()) - interval '2 hours'` })
      .where(and(eq(mailBombCounters.projectId, HRIS), eq(mailBombCounters.sender, 'cfg@x.com')));
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'cfg@x.com', to: HRIS_BOX, subject: 'NewHour', messageId: '<b3-new@x.com>' }), '<b3-new@x.com>');
    await intake.processReceived();
    const newRow = (await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.messageId, '<b3-new@x.com>')))[0]!;
    expect(newRow.status).toBe('processed'); // fresh window → not suppressed
  });
});
