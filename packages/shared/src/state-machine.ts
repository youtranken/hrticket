/**
 * Ticket lifecycle state machine (FR37) — the SINGLE source of truth for which
 * status transitions are legal. Pure: no DB, no side effects. Lives in @hris/shared
 * so the API guards every write with it AND the web client mirrors it to offer only
 * valid steps (architecture invariant #6 — no scattered `if (status === …)`).
 */
import type { TicketStatus } from './constants';

/** A transition reason that unlocks the "special close" edges (junk 7.4 / duplicate FR17). */
export type TransitionReason = 'junk' | 'duplicate';

export interface TransitionContext {
  /** Set for the junk/duplicate special-close from Open/Assigned. */
  reason?: TransitionReason;
  /** True when the caller supplies a snooze date — required to enter Pending (5.5). */
  hasSnoozeUntil?: boolean;
}

export type TransitionErrorCode = 'INVALID_TRANSITION' | 'PENDING_REQUIRES_SNOOZE';

export type TransitionResult = { ok: true } | { ok: false; code: TransitionErrorCode };

/**
 * The legal forward + branch + reopen graph (no reason). Reopen edges
 * (`closed → in_progress | open`) are system-driven (5.3 reply), never a manual pick.
 */
const GRAPH: Record<TicketStatus, TicketStatus[]> = {
  open: ['assigned'],
  assigned: ['in_progress'],
  in_progress: ['pending', 'resolved', 'closed'],
  pending: ['in_progress'],
  resolved: ['in_progress', 'closed'],
  closed: ['in_progress', 'open'],
};

/** Open/Assigned → Closed is allowed ONLY with a junk/duplicate reason (party-mode M3). */
const REASON_CLOSE_FROM: TicketStatus[] = ['open', 'assigned'];

/**
 * Decide whether `from → to` is allowed. Returns a discriminated result so callers
 * can map the code to the right HTTP status (INVALID_TRANSITION → 409;
 * PENDING_REQUIRES_SNOOZE → 422).
 */
export function canTransition(
  from: TicketStatus,
  to: TicketStatus,
  ctx: TransitionContext = {},
): TransitionResult {
  if (from === to) return { ok: false, code: 'INVALID_TRANSITION' };

  // Entering Pending always needs a snooze date (even though the edge exists).
  if (to === 'pending') {
    if (!GRAPH[from].includes('pending')) return { ok: false, code: 'INVALID_TRANSITION' };
    if (!ctx.hasSnoozeUntil) return { ok: false, code: 'PENDING_REQUIRES_SNOOZE' };
    return { ok: true };
  }

  if (GRAPH[from].includes(to)) return { ok: true };

  // Special close: dispatch a spam/duplicate ticket straight to Closed without the
  // claim→in_progress dance, but ONLY with an explicit reason (counter-metric §1.4).
  if (to === 'closed' && REASON_CLOSE_FROM.includes(from) && ctx.reason) return { ok: true };

  return { ok: false, code: 'INVALID_TRANSITION' };
}

/**
 * The transitions a human may pick from the status dropdown — the forward/branch
 * edges only. Reopen (closed →) is reply-driven and the pool assign (open →) is
 * claim-driven, so both are hidden from the manual picker (Story 5.1 AC3 / 5.2 AC4).
 */
const MANUAL: Record<TicketStatus, TicketStatus[]> = {
  open: [],
  assigned: ['in_progress'],
  in_progress: ['pending', 'resolved', 'closed'],
  pending: ['in_progress'],
  resolved: ['in_progress', 'closed'],
  closed: [],
};

export function manualNextStates(from: TicketStatus): TicketStatus[] {
  return MANUAL[from];
}
