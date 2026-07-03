import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { TicketStatus } from '@hris/shared';
import { withActor, type DbTx } from '../../infra/db/with-actor';
import { tickets, categories, ticketMessages, blocklist } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { actorForUser } from '../tickets/actor';
import { canActOnTicket } from '../tickets/ticket.state-machine';
import { addToBlocklist } from '../admin/block-sender';
import { canTransition } from '@hris/shared';
import { enqueueAutoAck } from '../intake/auto-ack';
import type { SessionUser } from '../auth/session.service';

/**
 * Who may mark a ticket as Rác by hand (Story 7.4 AC3, party-mode M3): everyone who
 * may already act on its lifecycle (assignee / TL-of-group / Admin / SSA — reused from
 * the foundation `canActOnTicket`), PLUS a Member in the ticket's category group when
 * it is still POOLED (no assignee) — so a member can junk obvious spam in the pool
 * without claiming it first. A member never marks someone else's ASSIGNED ticket.
 */
function canMarkJunk(
  user: SessionUser,
  groups: number[],
  ticket: { assigneeId: string | null; categoryId: number | null },
): boolean {
  if (canActOnTicket(user, groups, ticket)) return true;
  return (
    user.role === 'member' &&
    ticket.assigneeId === null &&
    ticket.categoryId !== null &&
    groups.includes(ticket.categoryId)
  );
}

export interface JunkTicket {
  id: string;
  ticketCode: string;
  subject: string;
  requesterEmail: string;
  categoryLabel: string;
  /** True = caught by a junk rule (auto); false = marked Rác by hand (7.4). */
  isAuto: boolean;
  /** The rule that caught it, from the audit trail (auto-junk only). */
  caughtBy: string | null;
  createdAt: string;
}

/**
 * Junk tab backend (Story 7.3, FR103). The list query is RLS-scoped via withActor:
 * the existing tickets_user policy grants Admin (whole project) + members of a
 * ticket's category group. Auto-junk tickets live in "Khác" → Admin + "Khác" members
 * see them; manual junk (7.4) keeps its original category → Admin + that group see it.
 * A member of an unrelated group gets an empty list (RLS filters the rows out).
 */
@Injectable()
export class JunkService {
  async list(user: SessionUser): Promise<JunkTicket[]> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          id: tickets.id,
          ticketCode: tickets.ticketCode,
          subject: tickets.subject,
          requesterEmail: tickets.requesterEmail,
          nameVi: categories.nameVi,
          nameEn: categories.nameEn,
          junkedFrom: tickets.junkedFromCategoryId,
          createdAt: tickets.createdAt,
          // Provenance from audit (no schema): the most recent auto_junked entry's
          // pattern, if any. Manual junk has none → null → rendered as "manual".
          caughtBy: sql<string | null>`(
            SELECT a.new_value->>'pattern' FROM audit_log a
            WHERE a.action = 'ticket.auto_junked' AND a.object_id = ${tickets.id}::text
            ORDER BY a.created_at DESC LIMIT 1
          )`,
        })
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .where(eq(tickets.isJunk, true))
        .orderBy(desc(tickets.createdAt));

      return rows.map((r) => ({
        id: r.id,
        ticketCode: r.ticketCode,
        subject: r.subject,
        requesterEmail: r.requesterEmail,
        categoryLabel: r.nameVi ?? r.nameEn ?? '—',
        // Auto = it was never junked-from another category (created straight into "Khác").
        isAuto: r.junkedFrom === null,
        caughtBy: r.caughtBy ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  /**
   * "Không phải rác" (FR103). Auto-junk → clear is_junk, stay in "Khác" (pool), send
   * the auto-ack NOW (it was withheld at intake). Manual junk (7.4) restoring the
   * original category/assignee/status is handled by the 7.4 release path; this method
   * covers the auto case and leaves a clear seam.
   */
  async release(user: SessionUser, ticketId: string): Promise<{ ok: true; reAcked: boolean }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          id: tickets.id,
          projectId: tickets.projectId,
          ticketCode: tickets.ticketCode,
          subject: tickets.subject,
          requesterEmail: tickets.requesterEmail,
          mailbox: tickets.mailbox,
          isJunk: tickets.isJunk,
          junkedFrom: tickets.junkedFromCategoryId,
          assigneeId: tickets.assigneeId,
          categoryId: tickets.categoryId,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .for('update');
      if (!t || !t.isJunk) throw new NotFoundException('Not a junk ticket');
      // Authorize the release the same way as marking junk (M1): release restores the
      // category / pre-close status and can re-trigger an auto-ack, so a non-assignee
      // member must NOT be able to resurrect someone else's junked ticket via RLS alone.
      const groups = actor.kind === 'user' ? actor.groups : [];
      if (!canMarkJunk(user, groups, t)) {
        throw new ForbiddenException('Not allowed to release this ticket');
      }

      // Manual junk (7.4) carries junked_from_category_id → restore the original
      // category + the pre-close status (read from the marked_junk audit, no schema),
      // keep the original assignee, clear junked_from, and do NOT re-ack (M4). Auto
      // junk → stays "Khác" (pool) and gets the withheld ack now.
      const isAuto = t.junkedFrom === null;

      if (!isAuto) {
        const priorStatus = await this.priorStatusFromAudit(tx, ticketId);
        await tx
          .update(tickets)
          .set({
            isJunk: false,
            categoryId: t.junkedFrom,
            junkedFromCategoryId: null,
            status: priorStatus,
            closedAt: null,
            lastOpenedAt: new Date(),
          })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.junk_released',
          objectType: 'ticket',
          objectId: ticketId,
          newValue: { isAuto: false, restoredCategory: t.junkedFrom, restoredStatus: priorStatus },
        });
        return { ok: true, reAcked: false };
      }

      await tx.update(tickets).set({ isJunk: false }).where(eq(tickets.id, ticketId));

      let reAcked = false;
      if (isAuto) {
        // Send the ack that was withheld when it was auto-junked (FR103: ack on rescue).
        // Thread it to the original inbound message so a reply lands back on this ticket.
        const [firstInbound] = await tx
          .select({ messageId: ticketMessages.messageId, toAddrs: ticketMessages.toAddrs })
          .from(ticketMessages)
          .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.direction, 'inbound')))
          .orderBy(ticketMessages.createdAt)
          .limit(1);
        // Đơn 15: the rescue-ack obeys the same To-gate as intake — a cc-only mail
        // stays silent even after a rescue (the requester addressed someone else).
        const ccOnly = !(firstInbound?.toAddrs ?? []).some(
          (a) => (a ?? '').toLowerCase() === t.mailbox.toLowerCase(),
        );
        await enqueueAutoAck(tx, {
          projectId: t.projectId,
          ticketId,
          ticketCode: t.ticketCode,
          mailbox: t.mailbox,
          requesterEmail: t.requesterEmail,
          requesterName: t.requesterEmail,
          subject: t.subject,
          inboundMessageId: firstInbound?.messageId ?? null,
          isAutoReply: false,
          isJunk: false,
          ccOnly,
        });
        reAcked = !ccOnly;
      }

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.junk_released',
        objectType: 'ticket',
        objectId: ticketId,
        newValue: { isAuto, reAcked },
      });
      return { ok: true, reAcked };
    });
  }

  /**
   * "Đánh dấu Rác" (FR104). Close the ticket via the state-machine junk edge, set
   * is_junk=true, and KEEP the original category + assignee — recording the original
   * category in junked_from_category_id so the Junk tab shows it to the original group
   * + Admin (NOT "Khác", party-mode M4 anti-leak) and "Không phải rác" can restore it.
   * Optionally blocks the sender (reuses 7.1 addToBlocklist). No auto-ack.
   */
  async markJunk(
    user: SessionUser,
    ticketId: string,
    opts: { blockSender?: boolean },
  ): Promise<{ ok: true; blocked: boolean }> {
    const actor = await actorForUser(user);
    const groups = actor.kind === 'user' ? actor.groups : [];
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          id: tickets.id,
          projectId: tickets.projectId,
          status: tickets.status,
          assigneeId: tickets.assigneeId,
          categoryId: tickets.categoryId,
          requesterEmail: tickets.requesterEmail,
          isJunk: tickets.isJunk,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .for('update');
      if (!t) throw new NotFoundException('Ticket not found'); // RLS-invisible → 404
      if (!canMarkJunk(user, groups, t)) {
        throw new ForbiddenException('Not allowed to mark this ticket as junk');
      }
      if (t.isJunk) return { ok: true, blocked: false }; // idempotent

      const from = t.status as TicketStatus;
      // The junk close must be a legal edge (Open/Assigned/In Progress → Closed with
      // reason 'junk'); a resolved/pending/closed ticket isn't junk-markable this way.
      // canTransition('resolved','closed') is otherwise a LEGAL edge, so guard the
      // from-state explicitly — relying on canTransition alone would let a resolved
      // ticket be junk-marked, contradicting the rule above (L2).
      const JUNKABLE_FROM: TicketStatus[] = ['open', 'assigned', 'in_progress'];
      if (!JUNKABLE_FROM.includes(from)) {
        throw new ForbiddenException('Ticket cannot be marked junk from this state');
      }
      const verdict = canTransition(from, 'closed', { reason: 'junk' });
      if (!verdict.ok) throw new ForbiddenException('Ticket cannot be marked junk from this state');

      await tx
        .update(tickets)
        .set({
          status: 'closed',
          closedAt: new Date(),
          isJunk: true,
          // Keep the original category; stash it for visibility + restore (M4).
          junkedFromCategoryId: t.categoryId,
        })
        .where(eq(tickets.id, ticketId));

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.marked_junk',
        objectType: 'ticket',
        objectId: ticketId,
        oldValue: { status: from, categoryId: t.categoryId },
        newValue: { isJunk: true, junkedFromCategoryId: t.categoryId },
      });

      let blocked = false;
      if (opts.blockSender && t.requesterEmail) {
        const res = await addToBlocklist(tx, {
          projectId: t.projectId,
          email: t.requesterEmail,
          reason: 'Marked junk from a ticket',
          createdBy: user.id,
          actorLabel: user.email,
        });
        blocked = res.created;
      }
      return { ok: true, blocked };
    });
  }

  /**
   * "Đánh dấu Spam thread" (FR42). Toggle is_spam_thread — the ticket STAYS in place
   * (no close, no category change). When on, an inbound reply only appends/logs (no
   * bump/reopen/notify/notice — enforced in reopen.usecase handleReplyTransition).
   * Permission = the standard lifecycle actor set (assignee/TL/Admin/SSA).
   * Đơn 7: marking spam ALSO blocklists the requester (their next mail is dropped at
   * the gate, no new ticket); un-marking removes them again — the toggle is the whole
   * story, no second trip to /admin/mail-protection.
   */
  async toggleSpamThread(
    user: SessionUser,
    ticketId: string,
    on: boolean,
  ): Promise<{ ok: true; isSpamThread: boolean; blocked: boolean }> {
    const actor = await actorForUser(user);
    const groups = actor.kind === 'user' ? actor.groups : [];
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          id: tickets.id,
          projectId: tickets.projectId,
          assigneeId: tickets.assigneeId,
          categoryId: tickets.categoryId,
          isSpamThread: tickets.isSpamThread,
          requesterEmail: tickets.requesterEmail,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .for('update');
      if (!t) throw new NotFoundException('Ticket not found');
      if (!canActOnTicket(user, groups, t)) {
        throw new ForbiddenException('Not allowed to change this ticket');
      }
      if (t.isSpamThread === on) return { ok: true, isSpamThread: on, blocked: on }; // idempotent

      await tx.update(tickets).set({ isSpamThread: on }).where(eq(tickets.id, ticketId));
      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: on ? 'ticket.spam_thread_on' : 'ticket.spam_thread_off',
        objectType: 'ticket',
        objectId: ticketId,
        newValue: { isSpamThread: on },
      });

      if (on) {
        await addToBlocklist(tx, {
          projectId: t.projectId,
          email: t.requesterEmail,
          reason: `spam_thread ${ticketId}`,
          createdBy: user.id,
          actorLabel: user.email,
        });
      } else {
        // Toggle OFF un-blocks the sender again — but ONLY the row THIS ticket's
        // spam-mark created (reason pins the ticket id), and only while NO other
        // still-marked spam thread of the same sender remains. A manual admin block
        // always survives (different reason) (review #3).
        const [otherSpam] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(tickets)
          .where(
            and(
              eq(tickets.projectId, t.projectId),
              sql`lower(${tickets.requesterEmail}) = lower(${t.requesterEmail})`,
              eq(tickets.isSpamThread, true),
              sql`${tickets.id} <> ${ticketId}`,
            ),
          );
        const removed =
          (otherSpam?.n ?? 0) > 0
            ? []
            : await tx
                .delete(blocklist)
                .where(
                  and(
                    eq(blocklist.projectId, t.projectId),
                    sql`lower(${blocklist.email}) = lower(${t.requesterEmail})`,
                    // Any spam-thread-created row (the creating ticket may differ when
                    // several threads shared one row) — manual admin rows never match.
                    sql`${blocklist.reason} LIKE 'spam_thread %'`,
                  ),
                )
                .returning({ id: blocklist.id });
        if (removed.length > 0) {
          await writeAudit(tx, {
            projectId: t.projectId,
            actorId: user.id,
            actorLabel: user.email,
            action: 'blocklist.removed',
            objectType: 'blocklist',
            objectId: String(removed[0]!.id),
            newValue: { email: t.requesterEmail, via: 'spam_thread_off' },
          });
        }
      }
      return { ok: true, isSpamThread: on, blocked: on };
    });
  }

  /** The status a ticket had right before it was manually junked, from the latest
   *  marked_junk audit (no schema). Falls back to 'open' if not found. */
  private async priorStatusFromAudit(tx: DbTx, ticketId: string): Promise<TicketStatus> {
    const rows = (await tx.execute(sql`
      SELECT old_value->>'status' AS status FROM audit_log
      WHERE action = 'ticket.marked_junk' AND object_id = ${ticketId}
      ORDER BY created_at DESC LIMIT 1
    `)) as unknown as Array<{ status: string | null }>;
    const s = rows[0]?.status;
    const valid: TicketStatus[] = ['open', 'assigned', 'in_progress', 'pending', 'resolved', 'closed'];
    return s && valid.includes(s as TicketStatus) ? (s as TicketStatus) : 'open';
  }
}
