import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { tickets, ticketMessages, participants, categories, drafts } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';
import { sendOutboundMail } from './send-mail.usecase';

export interface ReplyInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  body: string;
  bodyHtml?: string;
  attachmentIds?: string[];
  /** Client acknowledges the new-recipient warning (AC3). */
  confirmNewRecipients?: boolean;
}

export interface ReplyDefaults {
  to: string[];
  cc: string[];
  subject: string;
  isSensitive: boolean;
}

function htmlFromText(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<p>${esc.replace(/\n/g, '<br>')}</p>`;
}

function markerSubject(ticketCode: string, subject: string): string {
  const marker = `[${ticketCode}]`;
  return subject.includes(marker) ? subject : `${marker} ${subject}`;
}

@Injectable()
export class ReplyService {
  /** Reply-All suggestion (FR9): To=requester, CC=other active participants. */
  async getDefaults(user: SessionUser, ticketId: string): Promise<ReplyDefaults> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          requester: tickets.requesterEmail,
          subject: tickets.subject,
          ticketCode: tickets.ticketCode,
          isSensitive: categories.isSensitive,
        })
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .where(eq(tickets.id, ticketId));
      if (!t) throw new NotFoundException('Ticket not found');

      const active = await tx
        .select({ email: participants.email })
        .from(participants)
        .where(and(eq(participants.ticketId, ticketId), eq(participants.status, 'active')));

      const cc = active.map((p) => p.email).filter((e) => e !== t.requester);
      return {
        to: [t.requester],
        cc,
        subject: markerSubject(t.ticketCode, t.subject),
        isSensitive: t.isSensitive ?? false,
      };
    });
  }

  /**
   * Send an employee reply (FR6/7/8/9). One tx: optionally admit new recipients to
   * participants, write the outbound message with a fresh Message-ID, and enqueue
   * the outbox row with In-Reply-To/References threading + the `[#code]` subject.
   * New (never-seen) addresses are allowed but require confirmNewRecipients — the
   * server is the gate, the modal is only UX (party-mode J2).
   */
  async reply(
    user: SessionUser,
    ticketId: string,
    input: ReplyInput,
  ): Promise<{ ticketMessageId: string; messageId: string } | { needsConfirm: true; newRecipients: string[] }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          id: tickets.id,
          projectId: tickets.projectId,
          mailbox: tickets.mailbox,
          subject: tickets.subject,
          ticketCode: tickets.ticketCode,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      if (!t) throw new NotFoundException('Ticket not found');

      const allRecipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((e) =>
        e.toLowerCase(),
      );

      // Known = any participant we've seen (active OR pending) + the requester.
      const known = new Set(
        (
          await tx
            .select({ email: participants.email })
            .from(participants)
            .where(eq(participants.ticketId, ticketId))
        ).map((p) => p.email.toLowerCase()),
      );
      const newRecipients = [...new Set(allRecipients)].filter((e) => !known.has(e));

      if (newRecipients.length > 0 && !input.confirmNewRecipients) {
        return { needsConfirm: true as const, newRecipients };
      }

      // Admit confirmed new addresses as active participants + audit (J2).
      for (const email of newRecipients) {
        await tx
          .insert(participants)
          .values({ ticketId, email, status: 'active' })
          .onConflictDoUpdate({
            target: [participants.ticketId, participants.email],
            set: { status: 'active' },
          });
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'participant.added_on_reply',
          objectType: 'ticket',
          objectId: ticketId,
          newValue: { email },
        });
      }

      // Threading: hook onto the latest inbound message (FR7).
      const [lastInbound] = await tx
        .select({ messageId: ticketMessages.messageId, references: ticketMessages.references })
        .from(ticketMessages)
        .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.direction, 'inbound')))
        .orderBy(desc(ticketMessages.createdAt))
        .limit(1);
      const inReplyTo = lastInbound?.messageId ?? null;
      const references = [lastInbound?.references, lastInbound?.messageId]
        .filter((x): x is string => !!x)
        .join(' ') || null;

      const bodyHtml = input.bodyHtml ?? htmlFromText(input.body);
      const res = await sendOutboundMail(tx, {
        projectId: t.projectId,
        ticketId,
        fromAddr: t.mailbox,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: markerSubject(t.ticketCode, t.subject),
        bodyText: input.body,
        bodyHtml,
        inReplyTo,
        references,
        attachmentIds: input.attachmentIds,
      });

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.replied',
        objectType: 'ticket',
        objectId: ticketId,
        newValue: { messageId: res.messageId, to: input.to, cc: input.cc ?? [], bcc: input.bcc ?? [] },
      });

      // Reply sent → drop this user's reply draft IN THE SAME TX, so a stale draft
      // can't reload after a successful send and tempt a duplicate reply (FR105).
      await tx
        .delete(drafts)
        .where(
          and(eq(drafts.ticketId, ticketId), eq(drafts.userId, user.id), eq(drafts.kind, 'reply')),
        );

      return { ticketMessageId: res.ticketMessageId, messageId: res.messageId };
    });
  }
}
