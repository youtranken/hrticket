import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { tickets, ticketMessages, participants, attachments, inboxMessages } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { nextTicketCode } from '../tickets/ticket-code';
import { ingestAttachments } from './attachments';
import { enqueueAutoAck } from './auto-ack';
import { classifyTicket } from '../routing/classify.service';
import { applyAutoTags } from '../routing/auto-tag.service';
import { autoAssign } from '../routing/auto-assign.service';
import { sanitizeEmailHtml } from '../email-engine/sanitize';
import type { ParsedMail } from '../email-engine/parser';

export interface CreateTicketInput {
  projectId: number;
  mailbox: string;
  inboxMessageId: string;
  parsed: ParsedMail;
  /** Migration hook (FR20): explicit timestamps + provenance from an import. */
  createdAt?: Date;
  externalSource?: string;
  externalId?: string;
  /** 2.4 sets this for auto-submitted mail. */
  isAutoReply?: boolean;
}

export interface CreateTicketResult {
  ticketId: string;
  ticketCode: string;
  messageId: string;
}

/**
 * Create a brand-new ticket from a parsed mail — ALL in the caller's transaction:
 * atomic ticket code, keyword classification (Story 4.1), the ticket (Open, pooled
 * — auto-assign is Story 4.2), the inbound message with full metadata + raw,
 * participants (From + CC active), auto-tags, audit, and flip the inbox row to
 * processed.
 */
export async function createTicketFromMail(
  tx: DbTx,
  input: CreateTicketInput,
): Promise<CreateTicketResult> {
  const { projectId, mailbox, parsed } = input;
  const classified = await classifyTicket(tx, projectId, parsed.subject, parsed.bodyText);
  const categoryId = classified.categoryId;
  const ticketCode = await nextTicketCode(tx, projectId);
  const requesterEmail = parsed.from?.address ?? 'unknown@unknown';
  const createdAt = input.createdAt ?? new Date();

  const [ticket] = await tx
    .insert(tickets)
    .values({
      projectId,
      ticketCode,
      subject: parsed.subject,
      requesterEmail,
      mailbox,
      categoryId,
      status: 'open',
      externalSource: input.externalSource ?? null,
      externalId: input.externalId ?? null,
      createdAt,
      lastOpenedAt: createdAt,
    })
    .returning({ id: tickets.id });
  const ticketId = ticket!.id;

  const [message] = await tx
    .insert(ticketMessages)
    .values({
      ticketId,
      direction: 'inbound',
      fromAddr: requesterEmail,
      toAddrs: parsed.to.map((a) => a.address),
      ccAddrs: parsed.cc.map((a) => a.address),
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references.join(' ') || null,
      isAutoReply: input.isAutoReply ?? false,
      createdAt: parsed.date ?? createdAt,
    })
    .returning({ id: ticketMessages.id });

  const cidMap = await ingestAttachments(tx, {
    ticketId,
    messageId: message!.id,
    projectId,
    when: createdAt,
    attachments: parsed.attachments,
  });

  // Sanitize the HTML body for display (3.7) — raw stays in body_html for audit (FR19).
  await tx
    .update(ticketMessages)
    .set({ bodyHtmlSafe: sanitizeEmailHtml(parsed.bodyHtml, cidMap) })
    .where(eq(ticketMessages.id, message!.id));

  // Participants: requester + CC, all active. Dedup against the unique (ticket,email).
  const people = new Set<string>(
    [parsed.from, ...parsed.cc].filter(Boolean).map((a) => (a as { address: string }).address),
  );
  for (const email of people) {
    await tx
      .insert(participants)
      .values({ ticketId, email, status: 'active' })
      .onConflictDoNothing({ target: [participants.ticketId, participants.email] });
  }

  // Auto-tag (FR32/FR33): a stored attachment, an auto-reply message, priority
  // keyword rules. Cross-post is tagged later by linkCrossPost (intake orchestrator).
  const [hasStored] = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.ticketId, ticketId), eq(attachments.status, 'stored')))
    .limit(1);
  await applyAutoTags(tx, {
    projectId,
    ticketId,
    subject: parsed.subject,
    body: parsed.bodyText,
    signals: {
      hasStoredAttachment: !!hasStored,
      isAutoReply: input.isAutoReply ?? false,
    },
  });

  // Auto-assign (Story 4.2) in the SAME tx: round-robin / least-load over the
  // category roster, skipping away members. "Khác", no config, or all-away → pool.
  await autoAssign(tx, { projectId, ticketId, ticketCode, categoryId });

  await tx
    .update(inboxMessages)
    .set({ status: 'processed', ticketId })
    .where(eq(inboxMessages.id, input.inboxMessageId));

  await writeAudit(tx, {
    projectId,
    actorLabel: 'system:intake',
    action: 'ticket.created_from_email',
    objectType: 'ticket',
    objectId: ticketId,
    newValue: {
      ticketCode,
      requesterEmail,
      mailbox,
      categoryId,
      classifyReason: classified.reason,
      matchedKeywords: classified.matchedKeywords,
    },
  });

  // Auto-ack the requester (FR10) — only for genuine NEW tickets. Auto-submitted
  // mail never gets one (anti-loop layer 2, AC3); junk is a no-op hook until Epic 7.
  await enqueueAutoAck(tx, {
    projectId,
    ticketId,
    ticketCode,
    mailbox, // project mailbox = From
    requesterEmail,
    requesterName: parsed.from?.name ?? requesterEmail,
    subject: parsed.subject,
    inboundMessageId: parsed.messageId,
    isAutoReply: input.isAutoReply ?? false,
    isJunk: false,
  });

  return { ticketId, ticketCode, messageId: message!.id };
}
