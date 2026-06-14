import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import {
  categories,
  userGroupMembership,
  tickets,
  ticketMessages,
  reminderConfig,
} from '../src/infra/db/schema';
import { TicketStatusService } from '../src/modules/tickets/ticket-status.service';
import { TicketsReadService } from '../src/modules/tickets/tickets-read.service';
import { handleReplyTransition } from '../src/modules/intake/reopen.usecase';
import type { SessionUser } from '../src/modules/auth/session.service';

const REQ = 'req@x.com';
const session = (id: string, email: string, role: SessionUser['role'], projectId: number | null): SessionUser => ({
  id,
  email,
  name: email,
  role,
  projectId,
  disabled: false,
  mustChangePassword: false,
});

/** VN calendar date N days from today as 'YYYY-MM-DD'. */
function vnDateStr(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/**
 * IT-SNOOZE-001/002 + IT-OVERDUE-001 — Story 5.5/5.6. Entering Pending demands a
 * future date (422 otherwise); a reply wakes it; snoozed tickets are excluded from
 * overdue, a past-snooze counts from the snooze date, and the threshold is per
 * project. Time is moved by back-dating rows, never the clock. Needs Docker.
 */
describe('IT-SNOOZE / IT-OVERDUE: pending + overdue flags', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const statusSvc = new TicketStatusService();
  const readSvc = new TicketsReadService();
  let Payroll: number;
  let A: SessionUser; // assignee in project 1
  let SSA: SessionUser; // reads across projects

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      const a = (await makeUser(harness.db, { projectId: 1, email: 'a-snz@x.com' }))!;
      const ssa = (await makeUser(harness.db, { projectId: 1, email: 'ssa-snz@x.com', role: 'ssa' }))!;
      A = session(a.id, a.email, 'member', 1);
      SSA = session(ssa.id, ssa.email, 'ssa', 1);
      await harness.db.insert(userGroupMembership).values([{ userId: A.id, categoryId: Payroll }]);
      // Project 2 gets a longer overdue threshold (5 days) for AC4.
      await harness.db.update(reminderConfig).set({ overdueDays: 5 }).where(eq(reminderConfig.projectId, 2));
      ready = true;
    } catch (e) {
      console.warn('[IT-SNOOZE] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  let seq = 0;
  async function make(opts: {
    projectId?: number;
    status?: string;
    assigneeId?: string | null;
    lastOpenedAt?: Date;
    snoozeUntil?: string | null;
  }): Promise<string> {
    seq += 1;
    const pid = opts.projectId ?? 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: pid,
        ticketCode: `#S${String(seq).padStart(5, '0')}`,
        subject: 'snooze',
        requesterEmail: REQ,
        mailbox: pid === 1 ? 'hris@test.local' : 'cnb@test.local',
        categoryId: pid === 1 ? Payroll : null,
        status: (opts.status ?? 'in_progress') as 'open',
        assigneeId: opts.assigneeId ?? null,
        snoozeUntil: opts.snoozeUntil ?? null,
        lastOpenedAt: opts.lastOpenedAt ?? new Date(),
      })
      .returning({ id: tickets.id });
    return row!.id;
  }
  const detail = (u: SessionUser, id: string) => readSvc.getDetail(u, id);

  it('IT-SNOOZE-001: Pending needs a future date (422); a reply wakes it (AC1/AC3)', async () => {
    if (!ready) return;
    const t = await make({ status: 'in_progress', assigneeId: A.id });

    // No date → 422.
    await expect(statusSvc.changeStatus(A, t, { to: 'pending' })).rejects.toMatchObject({ status: 422 });
    // Past date → 422.
    await expect(
      statusSvc.changeStatus(A, t, { to: 'pending', snoozeUntil: vnDateStr(-1) }),
    ).rejects.toMatchObject({ status: 422 });

    // Future date + reason → Pending + snooze + an internal note.
    await statusSvc.changeStatus(A, t, { to: 'pending', snoozeUntil: vnDateStr(2), note: 'waiting on payroll' });
    const [tk] = await harness!.db.select().from(tickets).where(eq(tickets.id, t));
    expect(tk!.status).toBe('pending');
    expect(tk!.snoozeUntil).toBe(vnDateStr(2));
    const notes = await harness!.db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t));
    expect(notes.some((n) => n.isInternal && n.bodyText === 'waiting on payroll')).toBe(true);

    // AC3 — a participant reply wakes it: Pending → In Progress, snooze cleared.
    await withActor(systemActor, (tx) =>
      handleReplyTransition(tx, {
        ticketId: t,
        projectId: 1,
        fromAddr: REQ,
        fromIsActiveParticipant: true,
        isAutoReply: false,
      }),
    );
    const [woke] = await harness!.db.select().from(tickets).where(eq(tickets.id, t));
    expect(woke!.status).toBe('in_progress');
    expect(woke!.snoozeUntil).toBeNull();
  });

  it('IT-SNOOZE-002 / IT-OVERDUE-001: overdue flag honours every exclusion + per-project threshold', async () => {
    if (!ready) return;
    // AC1 — 4 days old (threshold 3) → overdue 1 day; 2 days old → fine.
    const old4 = await make({ status: 'in_progress', assigneeId: A.id, lastOpenedAt: daysAgo(4) });
    const young = await make({ status: 'in_progress', assigneeId: A.id, lastOpenedAt: daysAgo(2) });
    expect((await detail(SSA, old4)).ticket.isOverdue).toBe(true);
    expect((await detail(SSA, old4)).ticket.overdueDays).toBe(1);
    expect((await detail(SSA, young)).ticket.isOverdue).toBe(false);

    // AC2 — snoozed-in-future (10d) not overdue even at 10 days old; Closed never;
    // a PAST snooze (4d ago, threshold 3) IS overdue, measured from the snooze date.
    const snoozed = await make({ status: 'pending', snoozeUntil: vnDateStr(10), lastOpenedAt: daysAgo(10) });
    const closed = await make({ status: 'closed', lastOpenedAt: daysAgo(30) });
    const pastSnooze = await make({ status: 'pending', snoozeUntil: vnDateStr(-4), lastOpenedAt: daysAgo(30) });
    expect((await detail(SSA, snoozed)).ticket.isOverdue).toBe(false);
    expect((await detail(SSA, snoozed)).ticket.snoozeDue).toBe(false);
    expect((await detail(SSA, closed)).ticket.isOverdue).toBe(false);
    expect((await detail(SSA, pastSnooze)).ticket.isOverdue).toBe(true);
    expect((await detail(SSA, pastSnooze)).ticket.snoozeDue).toBe(true);

    // AC3 — a ticket "reopened today" (last_opened_at now) is not overdue despite age.
    const reopened = await make({ status: 'in_progress', assigneeId: A.id, lastOpenedAt: new Date() });
    expect((await detail(SSA, reopened)).ticket.isOverdue).toBe(false);

    // AC4 — same 4-day age: project 1 (threshold 3) overdue, project 2 (threshold 5) not.
    const p1 = await make({ projectId: 1, status: 'in_progress', lastOpenedAt: daysAgo(4) });
    const p2 = await make({ projectId: 2, status: 'in_progress', lastOpenedAt: daysAgo(4) });
    expect((await detail(SSA, p1)).ticket.isOverdue).toBe(true);
    expect((await detail(SSA, p2)).ticket.isOverdue).toBe(false);
  });
});
