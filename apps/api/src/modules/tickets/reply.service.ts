import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { TicketStatus } from '@hris/shared';
import { withActor } from '../../infra/db/with-actor';
import { tickets, ticketMessages, participants, categories, drafts } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';
import { sendOutboundMail } from './send-mail.usecase';
import { canTransition, assertCanActOnTicket } from './ticket.state-machine';

export interface ReplyInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  body: string;
  bodyHtml?: string;
  attachmentIds?: string[];
  /** Client acknowledges the new-recipient warning (AC3). */
  confirmNewRecipients?: boolean;
  /** Reply & Close (FR39): send the reply AND close the ticket in one tx (5.2). */
  closeAfter?: boolean;
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
  ): Promise<
    | { ticketMessageId: string; messageId: string; closed: boolean }
    | { needsConfirm: true; newRecipients: string[] }
  > {
    const actor = await actorForUser(user);
    const groups = actor.kind === 'user' ? actor.groups : [];
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          id: tickets.id,
          projectId: tickets.projectId,
          mailbox: tickets.mailbox,
          subject: tickets.subject,
          ticketCode: tickets.ticketCode,
          status: tickets.status,
          assigneeId: tickets.assigneeId,
          categoryId: tickets.categoryId,
        })
        .from(tickets)
        // Lock the ticket for the whole tx so Reply & Close is atomic: the status can't
        // move between the legality precheck and the close write — no half-done state (P6/AC1).
        .where(eq(tickets.id, ticketId))
        .for('update');
      if (!t) throw new NotFoundException('Ticket not found');

      // Sending company email on a ticket is a privileged act: only the assignee /
      // TL-in-group / Admin / SSA may reply — NOT every member who can see the ticket
      // via RLS (M1). Gates the plain reply too, not just Reply & Close.
      assertCanActOnTicket(user, groups, t);

      // Reply & Close (AC1): the close must be legal BEFORE we send, so we never leave a
      // sent mail on a ticket we couldn't close. The ticket row is locked above, so the
      // status is stable for the rest of the tx.
      if (input.closeAfter) {
        if (!canTransition(t.status as TicketStatus, 'closed').ok) {
          throw new ConflictException('INVALID_TRANSITION');
        }
      }

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

      // Auto-claim on reply (#6): replying to an UNASSIGNED ticket takes it over so it
      // leaves the group pool — a pool ticket with an outbound reply but no owner is the
      // illogical state we're closing. Same tx; an open pool ticket also moves to
      // 'assigned' (mirrors claim), unless we're about to close it below.
      if (!t.assigneeId) {
        await tx
          .update(tickets)
          .set({
            assigneeId: user.id,
            assignedAt: new Date(),
            ...(t.status === 'open' && !input.closeAfter ? { status: 'assigned' as const } : {}),
          })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.assigned',
          objectType: 'ticket',
          objectId: ticketId,
          oldValue: { assigneeId: null },
          newValue: { assigneeId: user.id, via: 'reply' },
        });
      }

      // Reply sent → drop this user's reply draft IN THE SAME TX, so a stale draft
      // can't reload after a successful send and tempt a duplicate reply (FR105).
      await tx
        .delete(drafts)
        .where(
          and(eq(drafts.ticketId, ticketId), eq(drafts.userId, user.id), eq(drafts.kind, 'reply')),
        );

      // Reply & Close (FR39/NFR10): flip to Closed in the SAME tx. The outbox row is
      // already enqueued, so the mail is guaranteed to go even though we're now closed
      // — a rollback (e.g. enqueue failure above) takes the close down with it.
      if (input.closeAfter) {
        await tx
          .update(tickets)
          .set({ status: 'closed', closedAt: new Date() })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.status_changed',
          objectType: 'ticket',
          objectId: ticketId,
          oldValue: { status: t.status },
          newValue: { status: 'closed', via: 'reply_and_close' },
        });
      }

      return { ticketMessageId: res.ticketMessageId, messageId: res.messageId, closed: !!input.closeAfter };
    });
  }
}
