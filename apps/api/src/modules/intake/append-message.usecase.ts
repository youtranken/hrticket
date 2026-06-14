import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { ticketMessages, participants, inboxMessages } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { ingestAttachments } from './attachments';
import { sanitizeEmailHtml } from '../email-engine/sanitize';
import type { ParsedMail } from '../email-engine/parser';

export interface AppendInput {
  ticketId: string;
  ticketStatus: string;
  projectId: number;
  inboxMessageId: string;
  parsed: ParsedMail;
  isAutoReply?: boolean;
}

export interface AppendResult {
  messageId: string;
  /** New addresses parked as pending_approval (FR3) — the "stranger" warning. */
  strangers: string[];
}

/**
 * Append an inbound mail to an existing ticket (Story 2.3). Known participants stay
 * active (FR5); a new address is parked `pending_approval` and kept OUT of the
 * default reply-all until a human approves it (FR3). Appending to a Closed ticket
 * records the message but does NOT change status (reopen is Epic 5).
 */
export async function appendMessageToTicket(tx: DbTx, input: AppendInput): Promise<AppendResult> {
  const { ticketId, parsed } = input;

  const [message] = await tx
    .insert(ticketMessages)
    .values({
      ticketId,
      direction: 'inbound',
      fromAddr: parsed.from?.address ?? 'unknown@unknown',
      toAddrs: parsed.to.map((a) => a.address),
      ccAddrs: parsed.cc.map((a) => a.address),
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references.join(' ') || null,
      isAutoReply: input.isAutoReply ?? false,
      createdAt: parsed.date ?? new Date(),
    })
    .returning({ id: ticketMessages.id });

  const cidMap = await ingestAttachments(tx, {
    ticketId,
    messageId: message!.id,
    projectId: input.projectId,
    when: parsed.date ?? new Date(),
    attachments: parsed.attachments,
  });

  await tx
    .update(ticketMessages)
    .set({ bodyHtmlSafe: sanitizeEmailHtml(parsed.bodyHtml, cidMap) })
    .where(eq(ticketMessages.id, message!.id));

  const strangers: string[] = [];
  const addresses = new Set(
    [parsed.from, ...parsed.cc].filter(Boolean).map((a) => (a as { address: string }).address),
  );
  for (const email of addresses) {
    const [existing] = await tx
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.ticketId, ticketId), eq(participants.email, email)));
    if (!existing) {
      // New address on an existing thread → stranger, needs approval before reply-all.
      await tx
        .insert(participants)
        .values({ ticketId, email, status: 'pending_approval' })
        .onConflictDoNothing({ target: [participants.ticketId, participants.email] });
      strangers.push(email);
    }
  }

  await tx
    .update(inboxMessages)
    .set({ status: 'processed', ticketId })
    .where(eq(inboxMessages.id, input.inboxMessageId));

  await writeAudit(tx, {
    projectId: input.projectId,
    actorLabel: input.isAutoReply ? 'system:intake(auto-reply)' : 'system:intake',
    action: 'ticket.message_appended',
    objectType: 'ticket',
    objectId: ticketId,
    newValue: {
      messageId: parsed.messageId,
      strangers,
      appendedToClosed: input.ticketStatus === 'closed',
    },
  });

  return { messageId: message!.id, strangers };
}
