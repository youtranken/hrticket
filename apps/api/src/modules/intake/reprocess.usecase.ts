import { eq } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { inboxMessages } from '../../infra/db/schema';
import { parseMail } from '../email-engine/parser';
import { findThread } from '../email-engine/threading';
import { isAutoSubmitted } from '../email-engine/auto-submitted';
import { writeAudit } from '../../infra/audit/audit';
import { createTicketFromMail } from './create-ticket.usecase';
import { appendMessageToTicket } from './append-message.usecase';
import { linkCrossPost } from './cross-post';
import { matchJunkRule } from './junk-rules';

export type ReprocessOutcome = 'ticket_created' | 'appended' | 'junked';

export interface ReprocessResult {
  outcome: ReprocessOutcome;
  ticketId: string;
  ticketCode?: string;
}

/**
 * Re-run a held mail through the ingest pipeline FROM the junk stage (Story 7.2 M8,
 * "Xử lý lại"). Used to release a `suppressed` (mail-bomb) row — and reused by the
 * junk flows. Deliberately SKIPS dedupe/blocklist/mail-bomb so a release can't be
 * re-suppressed or re-blocked. Three outcomes (AC2):
 *   (a) no thread, no junk rule → new ticket + auto-ack;
 *   (b) reply matches an existing thread → append/reopen, NO new ticket, NO ack;
 *   (c) matches a junk rule → Junk tab, NO ack.
 * Runs in the caller's tx. The inbox row must currently be `suppressed` (or otherwise
 * re-runnable); the caller passes its id.
 */
export async function reprocessInboxMessage(
  tx: DbTx,
  inboxMessageId: string,
): Promise<ReprocessResult> {
  const [row] = await tx
    .select()
    .from(inboxMessages)
    .where(eq(inboxMessages.id, inboxMessageId))
    .for('update');
  if (!row) throw new Error('inbox message not found');

  const parsed = await parseMail(row.raw);
  const autoReply = isAutoSubmitted(parsed.headers);
  const match = await findThread(tx, parsed, row.projectId);

  // (b) reply to an existing thread → append/reopen, no new ticket, no ack.
  if (match) {
    await appendMessageToTicket(tx, {
      ticketId: match.ticketId,
      ticketStatus: match.status,
      projectId: row.projectId,
      inboxMessageId: row.id,
      parsed,
      isAutoReply: autoReply,
    });
    await writeAudit(tx, {
      projectId: row.projectId,
      actorLabel: 'system:intake',
      action: 'inbox.reprocessed',
      objectType: 'inbox_message',
      objectId: row.id,
      newValue: { outcome: 'appended', ticketId: match.ticketId },
    });
    return { outcome: 'appended', ticketId: match.ticketId };
  }

  // (c) junk-rule match (Story 7.3): create an is_junk ticket in "Khác", no auto-ack —
  // it lands in the Junk tab, same as a fresh junk-stage match.
  const from = parsed.from?.address;
  const junk = from
    ? await matchJunkRule(tx, row.projectId, {
        subject: parsed.subject,
        body: parsed.bodyText,
        from,
      })
    : null;

  // (a)/(c) create a new ticket — junk-flagged when a rule caught it.
  const created = await createTicketFromMail(tx, {
    projectId: row.projectId,
    mailbox: row.mailbox,
    inboxMessageId: row.id,
    parsed,
    isAutoReply: autoReply,
    isJunk: !!junk,
  });
  await linkCrossPost(tx, {
    ticketId: created.ticketId,
    projectId: row.projectId,
    mailbox: row.mailbox,
    messageId: row.messageId,
  });
  if (junk) {
    await writeAudit(tx, {
      projectId: row.projectId,
      actorLabel: 'system:intake',
      action: 'ticket.auto_junked',
      objectType: 'ticket',
      objectId: created.ticketId,
      newValue: { ruleId: junk.ruleId, kind: junk.kind, pattern: junk.pattern },
    });
  }
  const outcome: ReprocessOutcome = junk ? 'junked' : 'ticket_created';
  await writeAudit(tx, {
    projectId: row.projectId,
    actorLabel: 'system:intake',
    action: 'inbox.reprocessed',
    objectType: 'inbox_message',
    objectId: row.id,
    newValue: { outcome, ticketId: created.ticketId, ticketCode: created.ticketCode },
  });
  return { outcome, ticketId: created.ticketId, ticketCode: created.ticketCode };
}
