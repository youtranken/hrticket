import { createHash } from 'node:crypto';
import type { DbTx } from '../../infra/db/with-actor';
import { loadTemplate, renderTemplate } from '../email-engine/templates';
import { sendOutboundMail } from '../tickets/send-mail.usecase';
import { sign } from '../../infra/crypto/signing';
import { emailShell } from '../../infra/mail/email-template';

const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:8080';

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
  /** Đơn 15 (3/7/2026): our mailbox was only Cc'd (or not addressed at all). The
   *  ticket still exists for tracking, but the requester addressed SOMEONE ELSE —
   *  acking would answer on their behalf, so we stay silent. */
  ccOnly: boolean;
}

/**
 * Enqueue the "we received your request, ticket {{ticketCode}}" auto-ack to the
 * requester ONLY (never CC), in the caller's tx (FR10). The subject is a
 * Gmail-threadable `Re: <original>`; threading headers make a reply to the ack
 * land back on the same ticket (AC4). Suppressed for auto-submitted or junk mail,
 * and for mail where our mailbox is only a Cc bystander (đơn 15).
 */
export async function enqueueAutoAck(tx: DbTx, input: AutoAckInput): Promise<void> {
  if (input.isAutoReply || input.isJunk || input.ccOnly) return;

  const tpl = await loadTemplate(tx, input.projectId, 'auto_ack');
  if (!tpl) return; // not seeded → skip rather than crash intake

  // The requester's language is unknown → the auto-ack is BILINGUAL: Vietnamese first,
  // then an English section under a divider. Both render from the template's vi/en columns.
  const vars = {
    ticketCode: input.ticketCode,
    subject: input.subject,
    requesterName: input.requesterName,
  };
  const vi = renderTemplate(tpl, 'vi', vars);
  const en = renderTemplate(tpl, 'en', vars);

  // Subject = `Re: <original>` so Gmail files the ack INTO the requester's own
  // conversation (Gmail threads on References + matching subject modulo Re:/Fwd: —
  // the old `[#code] <template subject>` opened a second conversation). The ticket
  // code stays visible in the heading + template body; inbound matching runs on
  // References, so nothing is lost by dropping the subject marker.
  const subject = /^\s*re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`;

  // Public status-tracking link (#7): a token-signed URL the requester can open without
  // logging in to see Đã tiếp nhận / Đang xử lý / Hoàn tất. Appended in code so it works
  // regardless of the seeded template wording.
  const statusUrl = `${APP_BASE_URL}/track/${sign(input.ticketId)}`;
  const trackVi = `Tra cứu tình trạng xử lý yêu cầu của bạn tại: ${statusUrl}`;
  const trackEn = `Track your request status at: ${statusUrl}`;
  const bodyText = `${vi.bodyText}\n\n${trackVi}\n\n———\n\n${en.bodyText}\n\n${trackEn}`;
  const linkBtn = (label: string) =>
    `<p style="margin:14px 0 0;"><a href="${statusUrl}" style="display:inline-block;background:#1F3A5F;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:14px;">${label}</a></p>`;
  const bodyHtml = emailShell({
    heading: `Đã tiếp nhận yêu cầu ${input.ticketCode} · Request received`,
    bodyHtml:
      `${vi.bodyHtml}` +
      linkBtn('Tra cứu tình trạng xử lý') +
      `<hr style="border:none;border-top:1px solid #eaedf3;margin:22px 0;"/>` +
      `${en.bodyHtml}` +
      linkBtn('Track your request status'),
  });

  await sendOutboundMail(tx, {
    projectId: input.projectId,
    ticketId: input.ticketId,
    fromAddr: input.mailbox,
    to: [input.requesterEmail],
    subject,
    bodyText,
    bodyHtml,
    inReplyTo: input.inboundMessageId,
    references: input.inboundMessageId,
    isAutoReply: true,
    autoSubmitted: true,
    // Deterministic key (1 ack per ticket): the inbox replay guard already prevents
    // a double ack, this makes the outbox layer itself idempotent as defence-in-depth.
    idempotencyKey: deterministicUuid(`auto_ack:${input.ticketId}`),
  });
}
