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
