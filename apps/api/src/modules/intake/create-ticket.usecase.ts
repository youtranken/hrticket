import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import {
  tickets,
  ticketMessages,
  participants,
  categories,
  inboxMessages,
} from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { nextTicketCode } from '../tickets/ticket-code';
import { ingestAttachments } from './attachments';
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

/** "Khác"/Other is the seeded system category — every new ticket lands here until
 *  real classification (Epic 4); routing here is the FR18 stub "always Other + pool". */
async function otherCategoryId(tx: DbTx, projectId: number): Promise<number> {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.projectId, projectId), eq(categories.isSystem, true)));
  return row!.id;
}

/**
 * Create a brand-new ticket from a parsed mail — ALL in the caller's transaction:
 * atomic ticket code, ticket (Open, Other category, pooled), the inbound message
 * with full metadata + raw, participants (From + CC active), audit, and flip the
 * inbox row to processed. Routing (classify + auto-assign) is a stub until Epic 4.
 */
export async function createTicketFromMail(
  tx: DbTx,
  input: CreateTicketInput,
): Promise<CreateTicketResult> {
  const { projectId, mailbox, parsed } = input;
  const categoryId = await otherCategoryId(tx, projectId);
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

  await ingestAttachments(tx, {
    ticketId,
    messageId: message!.id,
    projectId,
    when: createdAt,
    attachments: parsed.attachments,
  });

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
    newValue: { ticketCode, requesterEmail, mailbox },
  });

  return { ticketId, ticketCode, messageId: message!.id };
}
