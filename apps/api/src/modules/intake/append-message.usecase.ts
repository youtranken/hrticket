import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { tickets, ticketMessages, participants, attachments, inboxMessages } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { ingestAttachments } from './attachments';
import { applyAutoTags } from '../routing/auto-tag.service';
import { handleReplyTransition } from './reopen.usecase';
import { sanitizeEmailHtml } from '../email-engine/sanitize';
import { systemMailboxAddresses } from '../email-engine/mailbox-addresses';
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
  /** Addresses first seen on this mail — admitted ACTIVE immediately (approval removed). */
  strangers: string[];
}

/**
 * Append an inbound mail to an existing ticket (Story 2.3). Every address on the
 * mail (From/To/CC) joins the thread as an ACTIVE participant immediately — the
 * old `pending_approval` gate (FR3) was removed by request: reply-all now follows
 * the latest mail without a human approving newcomers first. The one guard kept:
 * a first-seen SENDER still can't reopen/wake a ticket (see below). Appending to
 * a Closed ticket records the message but does NOT change status (reopen: Epic 5).
 */
export async function appendMessageToTicket(tx: DbTx, input: AppendInput): Promise<AppendResult> {
  const { ticketId, parsed } = input;
  const ingestNow = new Date(); // ordering key + fallback/clamp for the display time

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
      // Display send-time = Date header, clamped to ingest when spoofed/skewed future (> +1d).
      createdAt:
        parsed.date && parsed.date.getTime() <= ingestNow.getTime() + 86_400_000
          ? parsed.date
          : ingestNow,
      // 12.1: ingest time = ordering key (late mail sinks below), see create-ticket.
      receivedAt: ingestNow,
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
  // From + To + CC of the reply are all thread members (reply-all parity) — minus our
  // own project mailboxes (the reply's To always contains US; cross-post also lists
  // the sibling mailbox — admitting either would loop replies back into ingest).
  const [tRow] = await tx
    .select({ mailbox: tickets.mailbox })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  const ownMailboxes = await systemMailboxAddresses(tx, tRow?.mailbox ?? '');
  const addresses = new Set(
    [parsed.from, ...parsed.to, ...parsed.cc]
      .filter(Boolean)
      .map((a) => (a as { address: string }).address)
      .filter((e) => !ownMailboxes.has(e.toLowerCase())),
  );
  // Reopen/wake guard input — captured BEFORE admission so a first-seen sender is
  // still treated as an outsider for lifecycle transitions (anti-abuse), even though
  // they now join the reply-all immediately.
  const fromAddr = parsed.from?.address;
  let fromWasActive = false;
  if (fromAddr) {
    const [p] = await tx
      .select({ status: participants.status })
      .from(participants)
      .where(and(eq(participants.ticketId, ticketId), eq(participants.email, fromAddr)));
    fromWasActive = p?.status === 'active';
  }
  for (const email of addresses) {
    const [existing] = await tx
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.ticketId, ticketId), eq(participants.email, email)));
    if (!existing) {
      // New address on an existing thread → ACTIVE right away (approval removed):
      // the next reply-all includes them without a human in the loop.
      await tx
        .insert(participants)
        .values({ ticketId, email, status: 'active' })
        .onConflictDoNothing({ target: [participants.ticketId, participants.email] });
      strangers.push(email);
    }
  }

  // Auto-tag the ticket from this message's signals (FR33): an auto-reply in the
  // thread, or a freshly-stored attachment. Idempotent (onConflictDoNothing).
  const [hasStored] = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.ticketId, ticketId), eq(attachments.status, 'stored')))
    .limit(1);
  await applyAutoTags(tx, {
    projectId: input.projectId,
    ticketId,
    subject: parsed.subject,
    body: parsed.bodyText,
    signals: {
      hasStoredAttachment: !!hasStored,
      isAutoReply: input.isAutoReply ?? false,
    },
  });

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

  // Lifecycle reaction (Epic 5): reopen a Closed ticket / wake a Pending one when a
  // KNOWN participant replies; locked/junk/spam append-only; auto-reply & first-seen
  // senders never drive a transition (fromWasActive was captured BEFORE this mail's
  // admission — post-admission everyone is active, which would void the guard).
  await handleReplyTransition(tx, {
    ticketId,
    projectId: input.projectId,
    fromAddr: fromAddr ?? 'unknown@unknown',
    fromIsActiveParticipant: fromWasActive,
    isAutoReply: input.isAutoReply ?? false,
  });

  return { messageId: message!.id, strangers };
}
