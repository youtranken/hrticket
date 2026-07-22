import { and, eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { tickets, ticketMessages, outbox, attachments, categories } from '../src/infra/db/schema';
import { ReplyService } from '../src/modules/tickets/reply.service';
import { OutboxSender } from '../src/modules/email-engine/outbox-sender.service';
import { Mailer } from '../src/infra/mail/mailer';
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
 * IT-UNDO-001..005 — Story 12.9. A plain reply/forward is HELD in the outbox for the
 * 8s undo window (next_attempt_at pushed out); Undo Send recalls it while still held —
 * deleting the outbox row + the just-written outbound message and unlinking its
 * attachments — and is refused once the worker has claimed it or the window passed.
 * A status-changing reply is never held. Needs Docker.
 */
describe('IT-UNDO: undo send holds the outbox and recalls the message', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new ReplyService();
  let ADMIN: SessionUser;
  let ticketId = '';
  let CAT = 0;
  let AID = '';

  let tkSeq = 0;
  async function mkTicket(): Promise<string> {
    tkSeq += 1;
    const [tk] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#UND${String(tkSeq).padStart(3, '0')}`,
        subject: 'undo send',
        requesterEmail: 'req-undo@ext.com',
        mailbox: 'hris@test.local',
        status: 'in_progress',
        categoryId: CAT,
        assigneeId: AID,
      })
      .returning({ id: tickets.id });
    return tk!.id;
  }

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const [payroll] = await harness.db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.projectId, 1), eq(categories.nameEn, 'Payroll')));
      CAT = payroll!.id;
      const a = (await makeUser(harness.db, { projectId: 1, email: 'adm-undo@x.com', role: 'admin' }))!;
      AID = a.id;
      ADMIN = session(a.id, a.email, 'admin', 1);
      ticketId = await mkTicket();
      ready = true;
    } catch (e) {
      console.warn('[IT-UNDO] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  async function sendReply(
    undo: boolean,
    extra: Partial<{ closeAfter: boolean; statusAfter: 'pending' | 'resolved'; snoozeUntil: string }> = {},
  ): Promise<{ outboxId?: string; undoable?: boolean; messageId: string }> {
    const r = (await svc.reply(ADMIN, ticketId, {
      to: ['someone@ext.com'],
      body: 'draft to recall',
      confirmNewRecipients: true,
      undo,
      ...extra,
    })) as { outboxId?: string; undoable?: boolean; messageId: string };
    return r;
  }

  it('IT-UNDO-001: a plain reply is held ~8s (not sent yet)', async () => {
    if (!ready) return;
    const r = await sendReply(true);
    expect(r.undoable).toBe(true);
    expect(r.outboxId).toBeTruthy();
    const rows = (await harness!.db.execute(
      sql`SELECT (next_attempt_at > now() + interval '5 seconds') AS held, status, smtp_dispatched_at FROM outbox WHERE id = ${r.outboxId}`,
    )) as unknown as Array<{ held: boolean; status: string; smtp_dispatched_at: string | null }>;
    expect(rows[0]?.held).toBe(true); // worker won't claim it until the window passes
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.smtp_dispatched_at).toBeNull();
  });

  it('IT-UNDO-002: undo within the window deletes outbox + message, unlinks attachments, audits', async () => {
    if (!ready) return;
    // A stored attachment to be linked at send and freed on undo.
    const [att] = await harness!.db
      .insert(attachments)
      .values({
        ticketId,
        fileName: 'f.pdf',
        mimeType: 'application/pdf',
        size: 10,
        storagePath: 'x/f.pdf',
        status: 'stored',
      })
      .returning({ id: attachments.id });

    const r = (await svc.reply(ADMIN, ticketId, {
      to: ['someone@ext.com'],
      body: 'has attachment',
      confirmNewRecipients: true,
      undo: true,
      attachmentIds: [att!.id],
    })) as { outboxId: string; messageId: string };

    // Linked at send.
    const linked = await harness!.db.select({ m: attachments.messageId }).from(attachments).where(eq(attachments.id, att!.id));
    expect(linked[0]!.m).not.toBeNull();

    await svc.undoSend(ADMIN, ticketId, r.outboxId);

    const ob = await harness!.db.select({ id: outbox.id }).from(outbox).where(eq(outbox.id, r.outboxId));
    expect(ob).toHaveLength(0); // outbox row gone
    const msg = await harness!.db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.messageId, r.messageId)));
    expect(msg).toHaveLength(0); // outbound message removed
    const freed = await harness!.db.select({ m: attachments.messageId }).from(attachments).where(eq(attachments.id, att!.id));
    expect(freed[0]!.m).toBeNull(); // attachment unlinked, kept for re-use
    const audits = (await harness!.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'reply.undone' AND object_id = ${ticketId}`,
    )) as unknown as Array<{ n: number }>;
    expect(audits[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it('IT-UNDO-003: once the worker has claimed the row, undo is refused (409 ALREADY_SENT)', async () => {
    if (!ready) return;
    const r = await sendReply(true);
    // Simulate the worker claiming the row for delivery.
    await harness!.db.update(outbox).set({ status: 'processing', lockedAt: new Date() }).where(eq(outbox.id, r.outboxId!));
    await expect(svc.undoSend(ADMIN, ticketId, r.outboxId!)).rejects.toMatchObject({ status: 409 });
    // The message + outbox row are untouched.
    const ob = await harness!.db.select({ id: outbox.id }).from(outbox).where(eq(outbox.id, r.outboxId!));
    expect(ob).toHaveLength(1);
  });

  it('IT-UNDO-004: an out-of-group member cannot undo (RLS 404, no leak)', async () => {
    if (!ready) return;
    const r = await sendReply(true);
    const m = (await makeUser(harness!.db, { projectId: 1, role: 'member', email: 'undo-out@x.com' }))!;
    const member = session(m.id, m.email, 'member', 1);
    await expect(svc.undoSend(member, ticketId, r.outboxId!)).rejects.toThrow();
  });

  it('IT-UNDO-005: a status-changing reply (closeAfter) is NOT held and not undoable', async () => {
    if (!ready) return;
    const r = await sendReply(true, { closeAfter: true });
    expect(r.undoable).toBeFalsy();
    const rows = (await harness!.db.execute(
      sql`SELECT (next_attempt_at <= now() + interval '2 seconds') AS immediate FROM outbox WHERE id = ${r.outboxId}`,
    )) as unknown as Array<{ immediate: boolean }>;
    expect(rows[0]?.immediate).toBe(true); // sent right away, no hold
  });

  it('IT-UNDO-006: the worker does NOT claim a held row before the window passes', async () => {
    if (!ready) return;
    const tid = await mkTicket();
    const r = (await svc.reply(ADMIN, tid, {
      to: ['w@ext.com'],
      body: 'held',
      confirmNewRecipients: true,
      undo: true,
    })) as { outboxId: string };
    // Run the real outbox worker: it must SKIP the held row (next_attempt_at in the future).
    await new OutboxSender(new Mailer()).runOnce();
    const rows = (await harness!.db.execute(
      sql`SELECT status, smtp_dispatched_at, locked_at FROM outbox WHERE id = ${r.outboxId}`,
    )) as unknown as Array<{ status: string; smtp_dispatched_at: string | null; locked_at: string | null }>;
    expect(rows[0]?.status).toBe('pending'); // untouched
    expect(rows[0]?.smtp_dispatched_at).toBeNull(); // never sent
    expect(rows[0]?.locked_at).toBeNull(); // never claimed
  });

  it('IT-UNDO-007: a row already in retry backoff (attempts>=1) is NOT recallable (409) — at-least-once', async () => {
    if (!ready) return;
    const tid = await mkTicket();
    const r = (await svc.reply(ADMIN, tid, {
      to: ['w@ext.com'],
      body: 'held',
      confirmNewRecipients: true,
      undo: true,
    })) as { outboxId: string; messageId: string };
    // Simulate a failed attempt now in backoff: pending + unlocked + FUTURE next_attempt, but
    // attempts>=1 (markFailure shape). Such a mail may already have been delivered → not recallable.
    await harness!.db
      .update(outbox)
      .set({ attempts: 1, nextAttemptAt: sql`now() + interval '60 seconds'` })
      .where(eq(outbox.id, r.outboxId));
    await expect(svc.undoSend(ADMIN, tid, r.outboxId)).rejects.toMatchObject({ status: 409 });
    // The row + message survive — undo must not drop a retry / recall a possibly-sent mail.
    const ob = await harness!.db.select({ id: outbox.id }).from(outbox).where(eq(outbox.id, r.outboxId));
    expect(ob).toHaveLength(1);
    const msg = await harness!.db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, tid), eq(ticketMessages.messageId, r.messageId)));
    expect(msg).toHaveLength(1);
  });

  it('IT-UNDO-009: once the window has elapsed (due) undo is refused even if not yet claimed', async () => {
    if (!ready) return;
    const tid = await mkTicket();
    const r = (await svc.reply(ADMIN, tid, {
      to: ['w@ext.com'],
      body: 'held',
      confirmNewRecipients: true,
      undo: true,
    })) as { outboxId: string };
    // Window passed (next_attempt_at now in the past) but the worker hasn't claimed it yet:
    // still pending, unlocked, attempts=0 — must NOT be recallable (the send is imminent).
    await harness!.db
      .update(outbox)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(outbox.id, r.outboxId));
    await expect(svc.undoSend(ADMIN, tid, r.outboxId)).rejects.toMatchObject({ status: 409 });
  });

  it('IT-UNDO-008: a forward is held and recallable too', async () => {
    if (!ready) return;
    const tid = await mkTicket();
    const [inb] = await harness!.db
      .insert(ticketMessages)
      .values({
        ticketId: tid,
        direction: 'inbound',
        fromAddr: 'fwd-src@ext.com',
        toAddrs: ['hris@test.local'],
        bodyText: 'to forward',
        receivedAt: new Date(),
      })
      .returning({ id: ticketMessages.id });
    const r = (await svc.forward(ADMIN, tid, {
      to: ['dest@ext.com'],
      ticketMessageId: inb!.id,
      confirmNewRecipients: true,
      undo: true,
    })) as { outboxId: string; messageId: string; undoable: boolean };
    expect(r.undoable).toBe(true);
    await svc.undoSend(ADMIN, tid, r.outboxId);
    const ob = await harness!.db.select({ id: outbox.id }).from(outbox).where(eq(outbox.id, r.outboxId));
    expect(ob).toHaveLength(0);
    const msg = await harness!.db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, tid), eq(ticketMessages.messageId, r.messageId)));
    expect(msg).toHaveLength(0);
  });
});
