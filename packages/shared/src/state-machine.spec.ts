import { describe, it, expect } from 'vitest';
import { canTransition, manualNextStates } from './state-machine';
import { TICKET_STATUSES, type TicketStatus } from './constants';

/**
 * UT-SM-001 — Story 5.1 AC1. The pure transition function must match the agreed
 * 6×6 table exactly. Cheap to test exhaustively, so we do (the state machine is the
 * system's 2nd most carefully-tested surface). `+s` marks "legal only with a snooze
 * date", `+r` marks "legal only with a junk/duplicate reason".
 */
const F: TicketStatus[] = [...TICKET_STATUSES];

// expected[from][to] = 'y' (always) | 'n' (never) | 's' (needs snooze) | 'r' (needs reason)
const T: Record<TicketStatus, Record<TicketStatus, 'y' | 'n' | 's' | 'r'>> = {
  open: { open: 'n', assigned: 'y', in_progress: 'n', pending: 'n', resolved: 'n', closed: 'r' },
  assigned: { open: 'n', assigned: 'n', in_progress: 'y', pending: 'n', resolved: 'n', closed: 'r' },
  in_progress: { open: 'n', assigned: 'n', in_progress: 'n', pending: 's', resolved: 'y', closed: 'y' },
  pending: { open: 'n', assigned: 'n', in_progress: 'y', pending: 'n', resolved: 'n', closed: 'n' },
  resolved: { open: 'n', assigned: 'n', in_progress: 'y', pending: 'n', resolved: 'n', closed: 'y' },
  closed: { open: 'y', assigned: 'n', in_progress: 'y', pending: 'n', resolved: 'n', closed: 'n' },
};

describe('canTransition — full 6×6 table (UT-SM-001)', () => {
  for (const from of F) {
    for (const to of F) {
      const cell = T[from][to];
      it(`${from} → ${to} (${cell})`, () => {
        // Plain attempt (no snooze, no reason).
        const plain = canTransition(from, to);
        if (cell === 'y') expect(plain.ok).toBe(true);
        else expect(plain.ok).toBe(false);

        // With a snooze date: only the 's' cell flips to legal.
        const withSnooze = canTransition(from, to, { hasSnoozeUntil: true });
        expect(withSnooze.ok).toBe(cell === 'y' || cell === 's');

        // With a junk reason: only the 'r' cell flips to legal.
        const withReason = canTransition(from, to, { reason: 'junk' });
        expect(withReason.ok).toBe(cell === 'y' || cell === 'r');
      });
    }
  }

  it('entering Pending without a date is PENDING_REQUIRES_SNOOZE, not INVALID_TRANSITION', () => {
    const r = canTransition('in_progress', 'pending');
    expect(r).toEqual({ ok: false, code: 'PENDING_REQUIRES_SNOOZE' });
  });

  it('a forbidden jump is INVALID_TRANSITION', () => {
    const r = canTransition('open', 'resolved');
    expect(r).toEqual({ ok: false, code: 'INVALID_TRANSITION' });
  });
});

describe('manualNextStates — only human-pickable edges (5.1 AC3)', () => {
  it('in_progress offers pending/resolved/closed, never open/assigned', () => {
    expect(manualNextStates('in_progress')).toEqual(['pending', 'resolved', 'closed']);
  });
  it('open and closed offer nothing (claim / reply-driven)', () => {
    expect(manualNextStates('open')).toEqual([]);
    expect(manualNextStates('closed')).toEqual([]);
  });
});
