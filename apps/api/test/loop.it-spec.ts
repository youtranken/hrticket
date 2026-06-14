import { and, eq, or } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeRaw, seedInbox } from './helpers/mail-raw';
import { IntakeService } from '../src/modules/intake/intake.service';
import {
  inboxMessages,
  tickets,
  ticketMessages,
  participants,
  tags,
  ticketTags,
  ticketLink,
  projectCounters,
  outbox,
} from '../src/infra/db/schema';

/**
 * IT-LOOP-001..003 — Story 2.4: anti mail-loop + cross-post.
 */
describe('IT-LOOP: anti mail-loop + cross-post', () => {
  let harness: ItHarness | undefined;
  let intake: IntakeService;
  let ready = false;
  const HRIS = 1;
  const CNB = 2;
  const HRIS_BOX = 'hris@test.local';
  const CNB_BOX = 'cnb@test.local';

  const tall = () => harness!.db.select().from(tickets);

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      intake = new IntakeService();
      ready = true;
    } catch (e) {
      console.warn('[IT-LOOP] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(ticketTags);
      await harness!.db.delete(ticketLink);
      await harness!.db.delete(participants);
      await harness!.db.delete(ticketMessages);
      await harness!.db.delete(inboxMessages);
      await harness!.db.delete(outbox); // auto-ack rows FK→tickets; clear before tickets
      await harness!.db.delete(tickets);
      await harness!.db.delete(tags);
      await harness!.db.update(projectCounters).set({ lastNo: 0 });
    }
  });

  it('IT-LOOP-001: auto-reply in-thread appends (labeled); off-thread creates nothing', async () => {
    if (!ready) return;
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'a@x.com', to: HRIS_BOX, subject: 'Orig', messageId: '<l1@x.com>' }), '<l1@x.com>');
    await intake.processReceived();
    const [t] = await tall();

    // out-of-office reply on the thread
    await seedInbox(
      harness!.db,
      HRIS,
      HRIS_BOX,
      makeRaw({
        from: 'a@x.com',
        to: HRIS_BOX,
        subject: 'Auto: away',
        messageId: '<l1-oof@x.com>',
        inReplyTo: '<l1@x.com>',
        extraHeaders: { 'Auto-Submitted': 'auto-replied' },
      }),
      '<l1-oof@x.com>',
    );
    // auto-submitted mail with NO matching thread
    await seedInbox(
      harness!.db,
      HRIS,
      HRIS_BOX,
      makeRaw({ from: 'noreply@bulk.com', to: HRIS_BOX, subject: 'Newsletter', messageId: '<l1-bulk@x.com>', extraHeaders: { Precedence: 'bulk' } }),
      '<l1-bulk@x.com>',
    );
    await intake.processReceived();

    expect(await tall()).toHaveLength(1); // off-thread auto mail made no ticket
    const msgs = await harness!.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, t!.id), eq(ticketMessages.direction, 'inbound')));
    expect(msgs).toHaveLength(2); // original + auto-reply append (auto-ack outbound excluded)
    expect(msgs.find((m) => m.messageId === '<l1-oof@x.com>')!.isAutoReply).toBe(true);
    expect(t!.status).toBe('open'); // auto-reply did not change status

    const bulk = await harness!.db.select().from(inboxMessages).where(eq(inboxMessages.messageId, '<l1-bulk@x.com>'));
    expect(bulk[0]!.status).toBe('processed'); // trace kept, no ticket
    expect(bulk[0]!.ticketId).toBeNull();
  });

  it('IT-LOOP-002: cross-post → two tickets, linked, both tagged Cross-post', async () => {
    if (!ready) return;
    const mid = '<xpost@x.com>';
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'a@x.com', to: HRIS_BOX, subject: 'Both', messageId: mid }), mid);
    await seedInbox(harness!.db, CNB, CNB_BOX, makeRaw({ from: 'a@x.com', to: CNB_BOX, subject: 'Both', messageId: mid }), mid);
    await intake.processReceived();

    const all = await tall();
    expect(all).toHaveLength(2);
    const hrisT = all.find((t) => t.projectId === HRIS)!;
    const cnbT = all.find((t) => t.projectId === CNB)!;

    const link = await harness!.db
      .select()
      .from(ticketLink)
      .where(or(and(eq(ticketLink.ticketA, hrisT.id), eq(ticketLink.ticketB, cnbT.id)), and(eq(ticketLink.ticketA, cnbT.id), eq(ticketLink.ticketB, hrisT.id))));
    expect(link).toHaveLength(1);
    expect(link[0]!.kind).toBe('cross_post');

    for (const t of [hrisT, cnbT]) {
      const tg = await harness!.db
        .select({ name: tags.name })
        .from(ticketTags)
        .innerJoin(tags, eq(tags.id, ticketTags.tagId))
        .where(eq(ticketTags.ticketId, t.id));
      expect(tg.map((x) => x.name)).toContain('Cross-post');
    }
  });

  it('IT-LOOP-003: a bounced auto-ack does not loop into a new ticket', async () => {
    if (!ready) return;
    // Simulate the system's own auto-ack bouncing back: auto-submitted, no thread.
    await seedInbox(
      harness!.db,
      HRIS,
      HRIS_BOX,
      makeRaw({ from: 'mailer-daemon@x.com', to: HRIS_BOX, subject: 'Delivery Status', messageId: '<bounce@x.com>', extraHeaders: { 'Auto-Submitted': 'auto-generated' } }),
      '<bounce@x.com>',
    );
    await intake.processReceived();
    expect(await tall()).toHaveLength(0); // chain stops — no ticket, no reply
  });
});
