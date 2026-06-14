import type { DbTx } from '../../infra/db/with-actor';
import { loadTemplate, renderTemplate } from '../email-engine/templates';
import { sendOutboundMail } from '../tickets/send-mail.usecase';

export interface AutoAckInput {
  projectId: number;
  ticketId: string;
  ticketCode: string; // "#00015"
  mailbox: string; // project mailbox = From
  requesterEmail: string;
  requesterName: string;
  subject: string;
  inboundMessageId: string | null;
  /** Inbound mail was auto-submitted → never ack (anti-loop layer 2, FR11/AC3). */
  isAutoReply: boolean;
  /** Junk hook (Epic 7) — keep the gate wired, always false for now. */
  isJunk: boolean;
}

/**
 * Enqueue the "we received your request, ticket {{ticketCode}}" auto-ack to the
 * requester ONLY (never CC), in the caller's tx (FR10). The subject carries the
 * `[#code]` marker + threading headers so a reply to the ack threads back to the
 * same ticket (AC4). Suppressed for auto-submitted or junk mail.
 */
export async function enqueueAutoAck(tx: DbTx, input: AutoAckInput): Promise<void> {
  if (input.isAutoReply || input.isJunk) return;

  const tpl = await loadTemplate(tx, input.projectId, 'auto_ack');
  if (!tpl) return; // not seeded → skip rather than crash intake

  const rendered = renderTemplate(tpl, 'vi', {
    ticketCode: input.ticketCode,
    subject: input.subject,
    requesterName: input.requesterName,
  });

  // Guarantee the [#code] marker on the subject regardless of template wording.
  const marker = `[${input.ticketCode}]`;
  const subject = rendered.subject.includes(marker)
    ? rendered.subject
    : `${marker} ${rendered.subject}`;

  await sendOutboundMail(tx, {
    projectId: input.projectId,
    ticketId: input.ticketId,
    fromAddr: input.mailbox,
    to: [input.requesterEmail],
    subject,
    bodyText: rendered.bodyText,
    bodyHtml: rendered.bodyHtml,
    inReplyTo: input.inboundMessageId,
    references: input.inboundMessageId,
    isAutoReply: true,
    autoSubmitted: true,
    // No explicit idempotency key needed: the ack is enqueued in the SAME tx as
    // ticket creation, and the replay guard (inbox_messages.ticket_id) stops the
    // ticket — and thus the ack — from being produced twice.
  });
}
