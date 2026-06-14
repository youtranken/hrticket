import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { TicketStatus } from '@hris/shared';
import { withActor, type DbTx } from '../../infra/db/with-actor';
import { tickets, ticketMessages, notifications } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';
import { canTransition, assertCanActOnTicket, type TransitionReason } from './ticket.state-machine';

interface StatusTicketRow {
  id: string;
  projectId: number;
  status: TicketStatus;
  assigneeId: string | null;
  categoryId: number | null;
  ticketCode: string;
}

export interface ChangeStatusInput {
  to: TicketStatus;
  /** Required (future VN date, 'YYYY-MM-DD') when entering Pending (5.5). */
  snoozeUntil?: string;
  /** Optional reason note when snoozing — stored as an internal note (5.5). */
  note?: string;
  /** junk / duplicate — unlocks the special-close edge from Open/Assigned (M3). */
  reason?: TransitionReason;
}

function htmlFromText(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${esc.replace(/\n/g, '<br>')}</p>`;
}

/**
 * Manual lifecycle transitions (Story 5.1/5.2/5.5). The state machine is the gate:
 * an illegal jump is 409 INVALID_TRANSITION with the DB untouched and no junk audit.
 * Entering Pending demands a future snooze date (422); leaving Pending back to work
 * clears the snooze and resets the overdue clock (5.5/5.6).
 */
@Injectable()
export class TicketStatusService {
  private async load(tx: DbTx, ticketId: string): Promise<StatusTicketRow> {
    const [t] = await tx
      .select({
        id: tickets.id,
        projectId: tickets.projectId,
        status: tickets.status,
        assigneeId: tickets.assigneeId,
        categoryId: tickets.categoryId,
        ticketCode: tickets.ticketCode,
      })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    if (!t) throw new NotFoundException('Ticket not found'); // RLS-invisible → 404, no leak
    return t as StatusTicketRow;
  }

  async changeStatus(
    user: SessionUser,
    ticketId: string,
    input: ChangeStatusInput,
  ): Promise<{ status: TicketStatus }> {
    const actor = await actorForUser(user);
    const groups = actor.kind === 'user' ? actor.groups : [];
    return withActor(actor, async (tx) => {
      // Serialize concurrent status changes on the same ticket.
      await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId)).for('update');
      const t = await this.load(tx, ticketId);
      assertCanActOnTicket(user, groups, t);

      const from = t.status;
      const to = input.to;

      // Pending needs a snooze date; validate it's not in the past (VN calendar day)
      // BEFORE consulting the state machine so the 422 wins over a 409.
      let snoozeDate: string | null = null;
      if (to === 'pending') {
        if (!input.snoozeUntil) {
          throw new UnprocessableEntityException('PENDING_REQUIRES_SNOOZE');
        }
        const rows = (await tx.execute(
          sql`SELECT (${input.snoozeUntil}::date < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS past`,
        )) as unknown as Array<{ past: boolean }>;
        if (rows[0]?.past) throw new UnprocessableEntityException('SNOOZE_DATE_IN_PAST');
        snoozeDate = input.snoozeUntil;
      }

      const verdict = canTransition(from, to, {
        hasSnoozeUntil: !!snoozeDate,
        reason: input.reason,
      });
      if (!verdict.ok) {
        if (verdict.code === 'PENDING_REQUIRES_SNOOZE') {
          throw new UnprocessableEntityException('PENDING_REQUIRES_SNOOZE');
        }
        throw new ConflictException('INVALID_TRANSITION');
      }

      const set: Record<string, unknown> = { status: to };
      if (to === 'pending') set.snoozeUntil = snoozeDate;
      if (to === 'closed') set.closedAt = new Date();
      // Resuming a snoozed ticket: drop the snooze and restart the overdue clock so a
      // long-pending ticket isn't instantly red (5.5/5.6 AC3).
      if (from === 'pending' && to === 'in_progress') {
        set.snoozeUntil = null;
        set.lastOpenedAt = new Date();
      }
      await tx.update(tickets).set(set).where(eq(tickets.id, ticketId));

      // The snooze reason becomes an internal note so the worklist carries the "why".
      if (to === 'pending' && input.note && input.note.trim()) {
        await tx.insert(ticketMessages).values({
          ticketId,
          direction: 'outbound',
          isInternal: true,
          fromAddr: user.email,
          bodyText: input.note,
          bodyHtmlSafe: htmlFromText(input.note),
        });
      }

      // Notify the assignee when someone else resumes their snoozed ticket.
      if (from === 'pending' && to === 'in_progress' && t.assigneeId && t.assigneeId !== user.id) {
        await tx.insert(notifications).values({
          actorId: t.assigneeId,
          type: 'ticket_resumed',
          payload: JSON.stringify({ ticketId, ticketCode: t.ticketCode, by: user.email }),
        });
      }

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.status_changed',
        objectType: 'ticket',
        objectId: ticketId,
        oldValue: { status: from },
        newValue: { status: to, snoozeUntil: snoozeDate, reason: input.reason },
      });

      return { status: to };
    });
  }
}
