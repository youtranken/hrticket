import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import {
  categories,
  users,
  userGroupMembership,
  tickets,
  notifications,
  outbox,
  reopenNoticeLog,
} from '../src/infra/db/schema';
import { handleReplyTransition } from '../src/modules/intake/reopen.usecase';
import { AssignmentService } from '../src/modules/tickets/assignment.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const REQ = 'req@x.com';

/**
 * IT-REOPEN-001..004 — Story 5.3/5.4. A participant reply reopens a Closed ticket
 * (keeping a still-valid assignee, else dropping to the pool so claim works), while
 * auto-replies, strangers, junk/spam, and locked tickets never reopen. Locked tickets
 * instead send a throttled "contact HR" notice. Needs Docker; self-skips.
 */
describe('IT-REOPEN: auto-reopen on reply', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const assignSvc = new AssignmentService();
  let Payroll: number;
  let A: string; // assignee, active + in Payroll
  let D: string; // active but NOT in Payroll (removed-from-group case)
  let M: SessionUser; // member in Payroll (claims a pooled reopen)

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      A = (await makeUser(harness.db, { projectId: 1, email: 'a-reopen@x.com' }))!.id;
      D = (await makeUser(harness.db, { projectId: 1, email: 'd-reopen@x.com' }))!.id;
      const m = (await makeUser(harness.db, { projectId: 1, email: 'm-reopen@x.com' }))!;
      M = {
        id: m.id,
        email: m.email,
        name: m.email,
        role: 'member',
        projectId: 1,
        disabled: false,
        mustChangePassword: false,
      };
      await harness.db.insert(userGroupMembership).values([
        { userId: A, categoryId: Payroll },
        { userId: M.id, categoryId: Payroll },
      ]);
      ready = true;
    } catch (e) {
      console.warn('[IT-REOPEN] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(reopenNoticeLog);
    await harness!.db.delete(outbox);
    await harness!.db.delete(notifications);
    await harness!.db.delete(tickets);
  });

  let seq = 0;
  async function makeClosed(opts: {
    assigneeId: string | null;
    reopenCount?: number;
    reopenLocked?: boolean;
    isJunk?: boolean;
    isSpamThread?: boolean;
    status?: string;
  }): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#R${String(seq).padStart(5, '0')}`,
        subject: 'reopen me',
        requesterEmail: REQ,
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: (opts.status ?? 'closed') as 'closed',
        assigneeId: opts.assigneeId,
        reopenCount: opts.reopenCount ?? 0,
        reopenLocked: opts.reopenLocked ?? false,
        isJunk: opts.isJunk ?? false,
        isSpamThread: opts.isSpamThread ?? false,
        lastOpenedAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  const fire = (
    ticketId: string,
    over: { fromIsActiveParticipant?: boolean; isAutoReply?: boolean } = {},
  ) =>
    withActor(systemActor, (tx) =>
      handleReplyTransition(tx, {
        ticketId,
        projectId: 1,
        fromAddr: REQ,
        fromIsActiveParticipant: over.fromIsActiveParticipant ?? true,
        isAutoReply: over.isAutoReply ?? false,
      }),
    );

  const load = async (id: string) =>
    (await harness!.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

  it('IT-REOPEN-001: requester reply → In Progress, keep assignee, bump count, notify', async () => {
    if (!ready) return;
    const t = await makeClosed({ assigneeId: A });
    const res = await fire(t);
    expect(res.action).toBe('reopened_assignee');
    const tk = await load(t);
    expect(tk.status).toBe('in_progress');
    expect(tk.assigneeId).toBe(A);
    expect(tk.reopenCount).toBe(1);
    expect(new Date(tk.lastOpenedAt).getFullYear()).toBe(new Date().getFullYear()); // reset
    const notes = await harness!.db.select().from(notifications).where(eq(notifications.actorId, A));
    expect(notes.some((n) => n.type === 'ticket_reopened')).toBe(true);
  });

  it('IT-REOPEN-002: auto-reply and stranger do NOT reopen', async () => {
    if (!ready) return;
    const t1 = await makeClosed({ assigneeId: A });
    await fire(t1, { isAutoReply: true });
    expect((await load(t1)).status).toBe('closed');
    expect((await load(t1)).reopenCount).toBe(0);

    const t2 = await makeClosed({ assigneeId: A });
    await fire(t2, { fromIsActiveParticipant: false });
    expect((await load(t2)).status).toBe('closed');
    expect((await load(t2)).reopenCount).toBe(0);
  });

  it('IT-REOPEN-003: assignee disabled OR removed-from-group → Open(pool) + claimable now', async () => {
    if (!ready) return;
    // (a) disabled assignee → pool.
    await harness!.db.update(users).set({ disabled: true }).where(eq(users.id, A));
    const t1 = await makeClosed({ assigneeId: A });
    const r1 = await fire(t1);
    expect(r1.action).toBe('reopened_pool');
    const tk1 = await load(t1);
    expect(tk1.status).toBe('open');
    expect(tk1.assigneeId).toBeNull();
    expect(tk1.reopenCount).toBe(1);
    // a group member can claim it RIGHT NOW (status=open AND assignee null).
    // claim() returns a union — a needsCategory branch here would be a test failure.
    const claimed = await assignSvc.claim(M, t1);
    if ('needsCategory' in claimed) throw new Error('unexpected needsCategory on claim');
    expect(claimed.assigneeId).toBe(M.id);
    await harness!.db.update(users).set({ disabled: false }).where(eq(users.id, A));

    // (b) active assignee but not in the ticket's group → pool.
    const t2 = await makeClosed({ assigneeId: D });
    const r2 = await fire(t2);
    expect(r2.action).toBe('reopened_pool');
    expect((await load(t2)).status).toBe('open');
    expect((await load(t2)).assigneeId).toBeNull();
  });

  it('IT-REOPEN-004: junk/spam/locked do NOT reopen; locked sends one throttled notice', async () => {
    if (!ready) return;
    // junk → append-only.
    const tj = await makeClosed({ assigneeId: A, isJunk: true });
    expect((await fire(tj)).action).toBe('junk_no_reopen');
    expect((await load(tj)).status).toBe('closed');

    // locked → notice once, no bump; a 2nd reply within 24h is throttled.
    const tl = await makeClosed({ assigneeId: A, reopenLocked: true, reopenCount: 6 });
    expect((await fire(tl)).action).toBe('locked_notice');
    expect((await load(tl)).status).toBe('closed');
    expect((await load(tl)).reopenCount).toBe(6); // no bump
    let ob = await harness!.db.select().from(outbox).where(eq(outbox.ticketId, tl));
    expect(ob.length).toBe(1);
    await fire(tl); // within 24h → throttled
    ob = await harness!.db.select().from(outbox).where(eq(outbox.ticketId, tl));
    expect(ob.length).toBe(1);

    // locked AND spam → silent (spam-thread wins, no notice).
    const ts = await makeClosed({ assigneeId: A, reopenLocked: true, isSpamThread: true });
    await fire(ts);
    expect((await harness!.db.select().from(outbox).where(eq(outbox.ticketId, ts))).length).toBe(0);

    // locked + auto-reply → no notice (anti-loop, 5.4 AC4).
    const ta = await makeClosed({ assigneeId: A, reopenLocked: true });
    await fire(ta, { isAutoReply: true });
    expect((await harness!.db.select().from(outbox).where(eq(outbox.ticketId, ta))).length).toBe(0);
  });
});
