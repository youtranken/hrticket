import { describe, it, expect } from 'vitest';
import { sortWorklist, WORKLIST_FIXTURE, WORKLIST_FIXTURE_ORDER } from './worklist-order';

describe('worklist ordering (FR106 spec)', () => {
  it('sorts the shared fixture into the canonical order', () => {
    const got = sortWorklist(WORKLIST_FIXTURE).map((i) => i.id);
    expect(got).toEqual(WORKLIST_FIXTURE_ORDER);
  });

  it('is a stable total order (idempotent + tie-break by id)', () => {
    const once = sortWorklist(WORKLIST_FIXTURE);
    const twice = sortWorklist(once);
    expect(twice.map((i) => i.id)).toEqual(once.map((i) => i.id));
  });

  it('snooze-due always outranks a plain overdue ticket', () => {
    const order = sortWorklist([
      { id: 'a', snoozeDue: false, isOverdue: true, overdueDays: 9, assignedAt: 1, lastOpenedAt: 1 },
      { id: 'b', snoozeDue: true, isOverdue: false, overdueDays: 0, assignedAt: 1, lastOpenedAt: 9 },
    ]).map((i) => i.id);
    expect(order).toEqual(['b', 'a']);
  });
});
