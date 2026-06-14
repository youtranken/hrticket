import { and, eq, gt, sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import {
  tickets,
  users,
  userGroupMembership,
  notifications,
  reopenNoticeLog,
} from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { loadTemplate, renderTemplate } from '../email-engine/templates';
import { sendOutboundMail } from '../tickets/send-mail.usecase';

export interface ReplyTransitionInput {
  ticketId: string;
  projectId: number;
  /** The inbound reply's From address. */
  fromAddr: string;
  /** True when From is already an ACTIVE participant (requester or admitted CC). A
   *  stranger (header matched, not a participant) never drives a transition (FR40). */
  fromIsActiveParticipant: boolean;
  /** Auto-submitted mail never reopens / bumps / sends a notice (FR40 exception). */
  isAutoReply: boolean;
}

interface ReopenTicketRow {
  status: string;
  assigneeId: string | null;
  categoryId: number | null;
  reopenCount: number;
  reopenLocked: boolean;
  isJunk: boolean;
  isSpamThread: boolean;
  requesterEmail: string;
  ticketCode: string;
  mailbox: string;
  subject: string;
}

async function notify(tx: DbTx, userId: string, type: string, payload: object): Promise<void> {
  await tx.insert(notifications).values({ actorId: userId, type, payload: JSON.stringify(payload) });
}

/**
 * React to an inbound reply landing on an existing ticket (Stories 5.3/5.4/5.5),
 * AFTER the message has been appended. Decides reopen / wake / locked-notice / nothing.
 * Returns the resulting status label so the caller can log it.
 */
export async function handleReplyTransition(
  tx: DbTx,
  input: ReplyTransitionInput,
): Promise<{ action: string }> {
  const [row] = await tx
    .select({
      status: tickets.status,
      assigneeId: tickets.assigneeId,
      categoryId: tickets.categoryId,
      reopenCount: tickets.reopenCount,
      reopenLocked: tickets.reopenLocked,
      isJunk: tickets.isJunk,
      isSpamThread: tickets.isSpamThread,
      requesterEmail: tickets.requesterEmail,
      ticketCode: tickets.ticketCode,
      mailbox: tickets.mailbox,
      subject: tickets.subject,
    })
    .from(tickets)
    .where(eq(tickets.id, input.ticketId));
  if (!row) return { action: 'none' };
  const t = row as ReopenTicketRow;

  // Auto-reply or stranger reply → append-only (already done by the caller).
  if (input.isAutoReply || !input.fromIsActiveParticipant) return { action: 'append_only' };

  // Wake a snoozed ticket on a participant reply (5.5 FR44): Pending → In Progress,
  // drop the snooze, restart the overdue clock, ping the assignee.
  if (t.status === 'pending') {
    await tx
      .update(tickets)
      .set({ status: 'in_progress', snoozeUntil: null, lastOpenedAt: new Date() })
      .where(eq(tickets.id, input.ticketId));
    if (t.assigneeId) {
      await notify(tx, t.assigneeId, 'ticket_resumed', {
        ticketId: input.ticketId,
        ticketCode: t.ticketCode,
        by: input.fromAddr,
      });
    }
    await writeAudit(tx, {
      projectId: input.projectId,
      actorLabel: 'system:intake',
      action: 'ticket.resumed_on_reply',
      objectType: 'ticket',
      objectId: input.ticketId,
      newValue: { by: input.fromAddr },
    });
    return { action: 'resumed' };
  }

  if (t.status !== 'closed') return { action: 'append_only' };

  // Locked → "contact HR" notice (throttled), NO reopen, NO bump (5.4 AC2).
  if (t.reopenLocked) {
    if (!t.isSpamThread) {
      const recent = await tx
        .select({ id: reopenNoticeLog.id })
        .from(reopenNoticeLog)
        .where(
          and(
            eq(reopenNoticeLog.ticketId, input.ticketId),
            eq(reopenNoticeLog.requesterEmail, t.requesterEmail),
            gt(reopenNoticeLog.sentAt, sql`now() - interval '24 hours'`),
          ),
        )
        .limit(1);
      if (recent.length === 0) {
        const tpl = await loadTemplate(tx, input.projectId, 'reopen_locked_notice');
        if (tpl) {
          const rendered = renderTemplate(tpl, 'vi', {
            ticketCode: t.ticketCode,
            subject: t.subject,
            requesterName: t.requesterEmail,
          });
          await sendOutboundMail(tx, {
            projectId: input.projectId,
            ticketId: input.ticketId,
            fromAddr: t.mailbox,
            to: [t.requesterEmail],
            subject: rendered.subject,
            bodyText: rendered.bodyText,
            bodyHtml: rendered.bodyHtml,
            isAutoReply: true,
            autoSubmitted: true,
          });
          await tx
            .insert(reopenNoticeLog)
            .values({ ticketId: input.ticketId, requesterEmail: t.requesterEmail });
        }
      }
    }
    await writeAudit(tx, {
      projectId: input.projectId,
      actorLabel: 'system:intake',
      action: 'ticket.reply_while_locked',
      objectType: 'ticket',
      objectId: input.ticketId,
      newValue: { by: input.fromAddr, spam: t.isSpamThread },
    });
    return { action: 'locked_notice' };
  }

  // Junk / spam-thread closed → append + log, no reopen (party-mode M5).
  if (t.isJunk || t.isSpamThread) {
    await writeAudit(tx, {
      projectId: input.projectId,
      actorLabel: 'system:intake',
      action: 'ticket.reply_while_junk',
      objectType: 'ticket',
      objectId: input.ticketId,
      newValue: { by: input.fromAddr, isJunk: t.isJunk, isSpamThread: t.isSpamThread },
    });
    return { action: 'junk_no_reopen' };
  }

  // --- Genuine reopen. Destination depends on the old assignee's standing. ---
  let keepAssignee = false;
  if (t.assigneeId) {
    const [u] = await tx
      .select({ disabled: users.disabled })
      .from(users)
      .where(eq(users.id, t.assigneeId));
    if (u && !u.disabled && t.categoryId !== null) {
      const [m] = await tx
        .select({ userId: userGroupMembership.userId })
        .from(userGroupMembership)
        .where(
          and(
            eq(userGroupMembership.userId, t.assigneeId),
            eq(userGroupMembership.categoryId, t.categoryId),
          ),
        );
      keepAssignee = !!m;
    }
  }

  const now = new Date();
  const reopenCount = t.reopenCount + 1;

  if (keepAssignee) {
    // Assignee still owns it → Closed → In Progress, keep them, notify per-reopen.
    await tx
      .update(tickets)
      .set({ status: 'in_progress', reopenCount, lastOpenedAt: now })
      .where(eq(tickets.id, input.ticketId));
    await notify(tx, t.assigneeId!, 'ticket_reopened', {
      ticketId: input.ticketId,
      ticketCode: t.ticketCode,
      by: input.fromAddr,
    });
  } else {
    // Assignee gone/removed-from-group → Closed → OPEN (pool), assignee NULL, so the
    // claim SQL (WHERE status='open' AND assignee IS NULL) picks it up — no ghost
    // ticket (party-mode M2/M9). Notify the whole group NOW (FR51/C5), not via digest.
    await tx
      .update(tickets)
      .set({ status: 'open', assigneeId: null, assignedAt: null, reopenCount, lastOpenedAt: now })
      .where(eq(tickets.id, input.ticketId));
    if (t.categoryId !== null) {
      const members = await tx
        .select({ id: users.id })
        .from(userGroupMembership)
        .innerJoin(users, eq(users.id, userGroupMembership.userId))
        .where(and(eq(userGroupMembership.categoryId, t.categoryId), eq(users.disabled, false)));
      for (const m of members) {
        await notify(tx, m.id, 'ticket_reopened_pool', {
          ticketId: input.ticketId,
          ticketCode: t.ticketCode,
          by: input.fromAddr,
        });
      }
    }
  }

  await writeAudit(tx, {
    projectId: input.projectId,
    actorLabel: 'system:intake',
    action: 'ticket.reopened',
    objectType: 'ticket',
    objectId: input.ticketId,
    oldValue: { status: 'closed', assigneeId: t.assigneeId },
    newValue: {
      by: input.fromAddr,
      at: now.toISOString(),
      reopenCount,
      toPool: !keepAssignee,
    },
  });
  return { action: keepAssignee ? 'reopened_assignee' : 'reopened_pool' };
}
