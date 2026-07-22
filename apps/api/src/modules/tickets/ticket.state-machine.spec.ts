import { canReplyTicket, canActOnTicket, type LifecycleTicket } from './ticket.state-machine';
import type { SessionUser } from '../auth/session.service';

/**
 * Story 12.3 — reply/forward is now allowed for ANY group member (Member or TL) of the
 * ticket's category, not just the assignee. This reverses the old assignee-first rule.
 * `canActOnTicket` (lifecycle supervision) is intentionally NOT widened here.
 */
function u(role: SessionUser['role'], id = 'u1'): SessionUser {
  return {
    id,
    email: `${id}@x.com`,
    name: id,
    role,
    projectId: 1,
    disabled: false,
    mustChangePassword: false,
  };
}
const PAYROLL = 10;
const ticket = (over: Partial<LifecycleTicket> = {}): LifecycleTicket => ({
  assigneeId: null,
  categoryId: PAYROLL,
  ...over,
});

describe('canReplyTicket (12.3 — group members may reply)', () => {
  it('assignee of any role may reply', () => {
    expect(canReplyTicket(u('member', 'me'), [], ticket({ assigneeId: 'me' }))).toBe(true);
    expect(canReplyTicket(u('admin', 'me'), [], ticket({ assigneeId: 'me' }))).toBe(true);
  });

  it('NEW: a Member in the ticket group may reply even when not the assignee', () => {
    expect(canReplyTicket(u('member'), [PAYROLL], ticket({ assigneeId: 'someone-else' }))).toBe(true);
  });

  it('a Team Lead in the ticket group may reply', () => {
    expect(canReplyTicket(u('team_lead'), [PAYROLL], ticket())).toBe(true);
  });

  it('a Member NOT in the ticket group is blocked', () => {
    expect(canReplyTicket(u('member'), [999], ticket())).toBe(false);
  });

  it('Admin / SSA who are NOT the assignee are blocked (administrative)', () => {
    expect(canReplyTicket(u('admin'), [PAYROLL], ticket({ assigneeId: 'other' }))).toBe(false);
    expect(canReplyTicket(u('ssa'), [PAYROLL], ticket({ assigneeId: 'other' }))).toBe(false);
  });

  it('a null-category ticket only lets the assignee reply', () => {
    expect(canReplyTicket(u('member'), [PAYROLL], ticket({ categoryId: null }))).toBe(false);
    expect(canReplyTicket(u('member', 'me'), [PAYROLL], ticket({ categoryId: null, assigneeId: 'me' }))).toBe(true);
  });
});

describe('canActOnTicket (12.3 — NOT widened; member-in-group still blocked)', () => {
  it('a non-assignee Member in the group cannot drive lifecycle (regression guard)', () => {
    expect(canActOnTicket(u('member'), [PAYROLL], ticket({ assigneeId: 'other' }))).toBe(false);
  });
  it('assignee, TL-in-group, Admin, SSA still can', () => {
    expect(canActOnTicket(u('member', 'me'), [], ticket({ assigneeId: 'me' }))).toBe(true);
    expect(canActOnTicket(u('team_lead'), [PAYROLL], ticket())).toBe(true);
    expect(canActOnTicket(u('admin'), [], ticket({ assigneeId: 'other' }))).toBe(true);
    expect(canActOnTicket(u('ssa'), [], ticket({ assigneeId: 'other' }))).toBe(true);
  });
});
