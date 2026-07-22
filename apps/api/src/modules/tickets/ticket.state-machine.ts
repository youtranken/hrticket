/**
 * State-machine entry point for the API (architecture invariant #6). The transition
 * graph itself lives in @hris/shared so the web client mirrors it exactly; this file
 * re-exports it and adds the (still pure) "who may act on this ticket" predicate so
 * every lifecycle service calls one place before writing.
 */
import { ForbiddenException } from '@nestjs/common';
import { canTransition, manualNextStates } from '@hris/shared';
import type { SessionUser } from '../auth/session.service';

export { canTransition, manualNextStates };
export type {
  TransitionContext,
  TransitionResult,
  TransitionReason,
  TransitionErrorCode,
} from '@hris/shared';

export interface LifecycleTicket {
  assigneeId: string | null;
  categoryId: number | null;
}

/**
 * Who may drive a ticket's lifecycle (status change / close / lock): the assignee,
 * the Team Lead of its category group, Admin (own project), or SSA. A Member who is
 * not the assignee is 403 — they must claim it first (Story 5.1 AC4 / 5.2 AC2).
 * Pure: `groups` is the caller's category-group ids, resolved upstream.
 */
export function canActOnTicket(
  user: SessionUser,
  groups: number[],
  ticket: LifecycleTicket,
): boolean {
  if (user.role === 'admin' || user.role === 'ssa') return true; // RLS already scoped the project
  if (ticket.assigneeId === user.id) return true;
  if (user.role === 'team_lead' && ticket.categoryId !== null && groups.includes(ticket.categoryId)) {
    return true;
  }
  return false;
}

export function assertCanActOnTicket(
  user: SessionUser,
  groups: number[],
  ticket: LifecycleTicket,
): void {
  if (!canActOnTicket(user, groups, ticket)) {
    throw new ForbiddenException('Not allowed to change this ticket');
  }
}

/**
 * Who may change a ticket's STATUS via the lifecycle dropdown: the HANDLER (assignee)
 * or Admin/SSA as a supervisory override. Tighter than `canActOnTicket` — a Team Lead
 * who isn't the assignee coordinates (assign), they don't drive the status; if a TL
 * wants to handle a ticket they assign it to themselves first. (junk/spam keep the wider
 * `canActOnTicket`, so a TL can still clean up.)
 */
export function canChangeStatus(user: SessionUser, ticket: LifecycleTicket): boolean {
  if (user.role === 'admin' || user.role === 'ssa') return true;
  return ticket.assigneeId === user.id;
}

export function assertCanChangeStatus(user: SessionUser, ticket: LifecycleTicket): void {
  if (!canChangeStatus(user, ticket)) {
    throw new ForbiddenException('Only the assignee may change this ticket status');
  }
}

/**
 * Who may SEND an outbound reply (process the conversation by emailing the requester):
 * the assignee, OR any Member/Team Lead of the ticket's category group (Story 12.3 —
 * the whole group can handle mail, not just whoever claimed it first). Still NARROWER
 * than `canActOnTicket` for the administrative tier — Admin/SSA are administrative (they
 * assign + oversee, e.g. close/lock/junk), they do NOT process tickets by replying
 * unless they are the assignee (model decision). Internal notes are a separate path
 * (no email leaves) and are not gated here.
 *
 * NOTE (12.3): this reversed the old "assignee-first" rule — reply is now WIDER than
 * lifecycle supervision for group members. Do not confuse with `canActOnTicket`
 * (status/close/lock still assignee + TL-in-group + Admin/SSA).
 */
export function canReplyTicket(
  user: SessionUser,
  groups: number[],
  ticket: LifecycleTicket,
): boolean {
  if (ticket.assigneeId === user.id) return true; // assignee of any role handles end-to-end
  if (user.role === 'admin' || user.role === 'ssa') return false; // administrative — don't process
  // Any group member (Member or Team Lead) of the ticket's category may reply/forward.
  if (ticket.categoryId !== null && groups.includes(ticket.categoryId)) return true;
  return false;
}

export function assertCanReplyTicket(
  user: SessionUser,
  groups: number[],
  ticket: LifecycleTicket,
): void {
  if (!canReplyTicket(user, groups, ticket)) {
    throw new ForbiddenException('Not allowed to reply to this ticket');
  }
}
