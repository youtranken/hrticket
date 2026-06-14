import { createHash } from 'node:crypto';
import type { DbTx } from '../../infra/db/with-actor';
import { loadTemplate, renderTemplate } from '../email-engine/templates';
import { sendOutboundMail } from '../tickets/send-mail.usecase';

/** Stable UUID derived from a name (v5-shaped) — lets the auto-ack carry a
 *  deterministic outbox idempotency key so a re-enqueue collapses to one row. */
function deterministicUuid(name: string): string {
  const h = createHash('sha256').update(name).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version
  h[8] = (h[8]! & 0x3f) | 0x80; // variant
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

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
    // Deterministic key (1 ack per ticket): the inbox replay guard already prevents
    // a double ack, this makes the outbox layer itself idempotent as defence-in-depth.
    idempotencyKey: deterministicUuid(`auto_ack:${input.ticketId}`),
  });
}
