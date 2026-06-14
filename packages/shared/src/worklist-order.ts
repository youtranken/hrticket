/**
 * Worklist ordering — the SINGLE spec for "which ticket bubbles to the top" (FR106).
 * Party-mode W9/A4: ONE spec, TWO implementations. This file is the authority:
 *   • Story 6.2 (digest) sorts in Node with `sortWorklist()` below.
 *   • Story 10.1 (worklist) writes the equivalent SQL `ORDER BY`.
 * An equivalence test runs BOTH over `WORKLIST_FIXTURE` and asserts identical order,
 * so the two can never drift.
 *
 * SPEC — ordered tie-break sequence (each only breaks ties left by the previous):
 *   ① snooze due now            → snooze_due      DESC   (due-today first)
 *   ② overdue                   → is_overdue      DESC   (overdue before on-time)
 *   ③ more overdue first        → overdue_days    DESC   (oldest breach first)
 *   ④ recently assigned         → assigned_at     DESC NULLS LAST (pool sinks)
 *   ⑤ by age (oldest first)     → last_opened_at  ASC
 *   ⑥ stable final tiebreak     → id              ASC
 */

export interface WorklistItem {
  id: string;
  /** snooze_until <= today (VN) — the snooze has come due (5.5). */
  snoozeDue: boolean;
  isOverdue: boolean;
  overdueDays: number;
  /** Epoch ms the current assignee was set; null when pooled/unassigned. */
  assignedAt: number | null;
  /** Epoch ms of the overdue clock (create / reopen / snooze-expiry — 5.6). */
  lastOpenedAt: number;
}

/** Total order matching the SPEC above. Negative → a before b. */
export function compareWorklist(a: WorklistItem, b: WorklistItem): number {
  if (a.snoozeDue !== b.snoozeDue) return a.snoozeDue ? -1 : 1; // ① due first
  if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1; // ② overdue first
  if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays; // ③ more overdue first
  if (a.assignedAt !== b.assignedAt) {
    // ④ recently assigned first; null (pool) sinks to the bottom.
    if (a.assignedAt === null) return 1;
    if (b.assignedAt === null) return -1;
    return b.assignedAt - a.assignedAt;
  }
  if (a.lastOpenedAt !== b.lastOpenedAt) return a.lastOpenedAt - b.lastOpenedAt; // ⑤ oldest first
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // ⑥ stable
}

export function sortWorklist<T extends WorklistItem>(items: T[]): T[] {
  return [...items].sort(compareWorklist);
}

/**
 * Shared fixture for the cross-implementation equivalence test (TS here, SQL in 10.1).
 * `expectedOrder` is the id sequence `sortWorklist` must produce — keep it in sync
 * with the SQL ORDER BY when 10.1 lands.
 */
export const WORKLIST_FIXTURE: WorklistItem[] = [
  { id: 'pool-old', snoozeDue: false, isOverdue: true, overdueDays: 2, assignedAt: null, lastOpenedAt: 1_000 },
  { id: 'snooze-1', snoozeDue: true, isOverdue: false, overdueDays: 0, assignedAt: 5_000, lastOpenedAt: 9_000 },
  { id: 'overdue-most', snoozeDue: false, isOverdue: true, overdueDays: 5, assignedAt: 3_000, lastOpenedAt: 2_000 },
  { id: 'overdue-less', snoozeDue: false, isOverdue: true, overdueDays: 2, assignedAt: 8_000, lastOpenedAt: 4_000 },
  { id: 'fresh', snoozeDue: false, isOverdue: false, overdueDays: 0, assignedAt: 9_000, lastOpenedAt: 8_000 },
  { id: 'snooze-2', snoozeDue: true, isOverdue: true, overdueDays: 1, assignedAt: 2_000, lastOpenedAt: 3_000 },
];

/** The order `sortWorklist(WORKLIST_FIXTURE)` must yield (ids). */
export const WORKLIST_FIXTURE_ORDER: string[] = [
  'snooze-2', // ① due (and overdue, so before the other due one via ②)
  'snooze-1', // ① due, not overdue
  'overdue-most', // ② overdue, ③ overdueDays 5
  'overdue-less', // overdueDays 2, ④ assigned 8000
  'pool-old', // overdueDays 2, ④ assigned NULL → pool sinks below overdue-less
  'fresh', // neither due nor overdue → last
];
