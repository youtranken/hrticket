import { and, eq, inArray } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { ticketMessages, attachments } from '../../infra/db/schema';
import { enqueue, generateMessageId } from '../../infra/queue/outbox.service';

export interface SendOutboundInput {
  projectId: number;
  ticketId: string;
  /** Project mailbox — the From address; also the Message-ID domain. */
  fromAddr: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  inReplyTo?: string | null;
  references?: string | null;
  isAutoReply?: boolean;
  autoSubmitted?: boolean;
  /** Stored attachments to link to this outbound message + send via SMTP (3.6). */
  attachmentIds?: string[];
  idempotencyKey?: string;
}

export interface SendOutboundResult {
  ticketMessageId: string;
  messageId: string;
  outboxId: string;
}

/**
 * Write an outbound mail to the conversation AND enqueue it for delivery in ONE
 * transaction (Story 3.1/3.2). The Message-ID is generated once and stored on
 * ticket_messages so a later inbound reply threads back (FR7). The outbox row
 * carries the SAME Message-ID + threading headers; the worker sends at-least-once.
 * Shared by auto-ack (3.3) and employee replies (3.2).
 */
export async function sendOutboundMail(
  tx: DbTx,
  input: SendOutboundInput,
): Promise<SendOutboundResult> {
  const messageId = generateMessageId(input.fromAddr);

  const [message] = await tx
    .insert(ticketMessages)
    .values({
      ticketId: input.ticketId,
      direction: 'outbound',
      fromAddr: input.fromAddr,
      toAddrs: input.to,
      ccAddrs: input.cc ?? null,
      bccAddrs: input.bcc ?? null,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      // We generate this HTML ourselves, so the "safe" copy is the same (FR12/3.7).
      bodyHtmlSafe: input.bodyHtml,
      messageId,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? null,
      isAutoReply: input.isAutoReply ?? false,
    })
    .returning({ id: ticketMessages.id });
  const ticketMessageId = message!.id;

  // Link uploaded attachments to this outbound message (3.6) — only stored ones for
  // this ticket, so a stray id can't smuggle another ticket's file into the mail.
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    await tx
      .update(attachments)
      .set({ messageId: ticketMessageId })
      .where(
        and(
          inArray(attachments.id, input.attachmentIds),
          eq(attachments.ticketId, input.ticketId),
          eq(attachments.status, 'stored'),
        ),
      );
  }

  const { outboxId } = await enqueue(tx, {
    projectId: input.projectId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    bodyHtml: input.bodyHtml,
    bodyText: input.bodyText,
    headers: {
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? null,
      autoSubmitted: input.autoSubmitted,
    },
    ticketId: input.ticketId,
    messageId,
    idempotencyKey: input.idempotencyKey,
  });

  return { ticketMessageId, messageId, outboxId };
}
