import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { tickets, ticketMessages, participants, attachments, inboxMessages } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { nextTicketCode } from '../tickets/ticket-code';
import { ingestAttachments } from './attachments';
import { enqueueAutoAck } from './auto-ack';
import { classifyTicket, otherCategoryId, type ClassifyResult } from '../routing/classify.service';
import { matchSenderDomain } from '../routing/sender-domain.service';
import { applyAutoTags } from '../routing/auto-tag.service';
import { autoAssign } from '../routing/auto-assign.service';
import { sanitizeEmailHtml } from '../email-engine/sanitize';
import { systemMailboxAddresses } from '../email-engine/mailbox-addresses';
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
  /** Story 7.3 (FR102/FR103): an auto-junk-rule match. When true the ticket is forced
   *  to category "Khác" with is_junk=true, is NOT auto-assigned, and gets NO auto-ack
   *  (it lands in the Junk tab). Default false → byte-identical to the normal flow. */
  isJunk?: boolean;
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
  const isJunk = input.isJunk ?? false;
  const requesterEmail = parsed.from?.address ?? 'unknown@unknown';

  // Category routing (FR104, Story 4.7 — DOMAIN-PRIMARY since categories are companies).
  // The sender's company domain is the clean, non-overlapping signal, so it decides first;
  // keyword classification (Story 4.1) is only a FALLBACK for senders with no domain rule
  // (e.g. a personal gmail that names a topic). Junk is unclassified → forced to "Khác".
  let categoryId: number;
  let classifySource: 'sender_domain' | 'keyword' | 'none';
  let senderRuleId: number | null = null;
  let classified: ClassifyResult | null = null;
  if (isJunk) {
    categoryId = await otherCategoryId(tx, projectId);
    classifySource = 'none';
  } else {
    const domain = await matchSenderDomain(tx, projectId, requesterEmail);
    if (domain) {
      categoryId = domain.categoryId;
      classifySource = 'sender_domain';
      senderRuleId = domain.ruleId;
    } else {
      classified = await classifyTicket(tx, projectId, parsed.subject, parsed.bodyText);
      categoryId = classified.categoryId;
      classifySource = classified.reason === 'single_match' ? 'keyword' : 'none';
    }
  }

  const ticketCode = await nextTicketCode(tx, projectId);
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
      isJunk,
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

  // Participants: requester + To + CC, all active — reply-all parity with Gmail
  // (the sender's To-recipients are part of the conversation too, FR9). Our own
  // project mailboxes are excluded: a cross-post lists BOTH mailboxes in To, and
  // admitting the sibling would loop every reply-all back into ingest.
  const ownMailboxes = await systemMailboxAddresses(tx, mailbox);
  const people = new Set<string>(
    [parsed.from, ...parsed.to, ...parsed.cc]
      .filter(Boolean)
      .map((a) => (a as { address: string }).address)
      .filter((e) => !ownMailboxes.has(e.toLowerCase())),
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
  // Junk (7.3) is NEVER auto-assigned — it waits in the Junk tab (FR103).
  if (!isJunk) {
    await autoAssign(tx, { projectId, ticketId, ticketCode, categoryId });
  }

  await tx
    .update(inboxMessages)
    .set({ status: 'processed', ticketId })
    .where(eq(inboxMessages.id, input.inboxMessageId));

  // Đơn 15 (3/7/2026): the ack additionally requires OUR mailbox to be a direct
  // To recipient. A mail that merely Cc's us (the requester addressed someone
  // else) still becomes a ticket for tracking, but stays SILENT toward the
  // requester — the To'd party is the one expected to answer.
  const mailboxInTo = parsed.to.some(
    (a) => (a.address ?? '').toLowerCase() === mailbox.toLowerCase(),
  );

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
      mailboxInTo, // false = cc-only → auto-ack suppressed (đơn 15)
      categoryId,
      isJunk,
      classifyReason: classified?.reason ?? null,
      matchedKeywords: classified?.matchedKeywords ?? [],
      classifySource, // 'keyword' | 'sender_domain' | 'none' (FR104)
      senderRuleId, // the category_sender_rules id when routed by domain
    },
  });

  // Auto-ack the requester (FR10) — only for genuine NEW tickets. Auto-submitted
  // mail never gets one (anti-loop layer 2, AC3); junk (7.3) gets NO ack either —
  // enqueueAutoAck's isJunk gate suppresses it (the ack is sent later on rescue).
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
    isJunk,
    ccOnly: !mailboxInTo,
  });

  return { ticketId, ticketCode, messageId: message!.id };
}
