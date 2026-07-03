import { eq, inArray, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import {
  categories,
  users,
  tickets,
  notifications,
  assignCursors,
  autoAssignConfig,
  autoAssignMembers,
} from '../src/infra/db/schema';
import { autoAssign, type AssignStrategy } from '../src/modules/routing/auto-assign.service';

/**
 * IT-ASSIGN-001..003 — Story 4.2. The system's 3rd hard-test zone: round-robin is
 * race-free under concurrency, least-load excludes Pending, away members are
 * skipped, and an all-away roster falls through to the pool. Needs Docker.
 */
describe('IT-ASSIGN: auto-assign round-robin / least-load', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const PROJECT = 1;
  let cat: Map<string, number>;
  let A: string;
  let B: string;
  let C: string;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const rows = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, PROJECT));
      cat = new Map(rows.map((r) => [r.nameEn, r.id]));
      A = (await makeUser(harness.db, { projectId: PROJECT, email: 'a-assign@x.com' }))!.id;
      B = (await makeUser(harness.db, { projectId: PROJECT, email: 'b-assign@x.com' }))!.id;
      C = (await makeUser(harness.db, { projectId: PROJECT, email: 'c-assign@x.com' }))!.id;
      ready = true;
    } catch (e) {
      console.warn('[IT-ASSIGN] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(tickets);
    await harness!.db.delete(notifications);
    await harness!.db.delete(autoAssignMembers);
    await harness!.db.delete(autoAssignConfig);
    await harness!.db.delete(assignCursors);
    await harness!.db
      .update(users)
      .set({ awayFrom: null, awayTo: null, disabled: false })
      .where(inArray(users.id, [A, B, C]));
  });

  /** Configure a category's roster + strategy. members = ordered user ids. */
  async function configure(categoryId: number, strategy: AssignStrategy, members: string[]) {
    const [cfg] = await harness!.db
      .insert(autoAssignConfig)
      .values({ categoryId, strategy })
      .returning({ id: autoAssignConfig.id });
    for (let i = 0; i < members.length; i++) {
      await harness!.db
        .insert(autoAssignMembers)
        .values({ configId: cfg!.id, userId: members[i]!, position: i });
    }
  }

  let codeSeq = 0;
  async function makePooled(categoryId: number): Promise<string> {
    codeSeq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: PROJECT,
        ticketCode: `#A${String(codeSeq).padStart(5, '0')}`,
        subject: 's',
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId,
        status: 'open',
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  async function makeAssigned(categoryId: number, userId: string, status: string, when: Date) {
    codeSeq += 1;
    await harness!.db.insert(tickets).values({
      projectId: PROJECT,
      ticketCode: `#A${String(codeSeq).padStart(5, '0')}`,
      subject: 's',
      requesterEmail: 'r@x.com',
      mailbox: 'hris@test.local',
      categoryId,
      status: status as 'open',
      assigneeId: userId,
      assignedAt: when,
    });
  }

  const assignOne = (ticketId: string, categoryId: number) =>
    withActor(systemActor, (tx) =>
      autoAssign(tx, { projectId: PROJECT, ticketId, ticketCode: '#x', categoryId }),
    );

  it('IT-ASSIGN-001: 9 concurrent round-robin tickets split 3/3/3, no double-assign (×10)', async () => {
    if (!ready) return;
    const Payroll = cat.get('Payroll')!;
    await configure(Payroll, 'round_robin', [A, B, C]);

    for (let iter = 0; iter < 10; iter++) {
      await harness!.db.delete(tickets);
      await harness!.db.delete(assignCursors);

      const ids = await Promise.all(Array.from({ length: 9 }, () => makePooled(Payroll)));
      await Promise.all(ids.map((id) => assignOne(id, Payroll)));

      const counts = await harness!.db
        .select({ assignee: tickets.assigneeId, n: sql<number>`count(*)::int` })
        .from(tickets)
        .groupBy(tickets.assigneeId);
      const byUser = new Map(counts.map((c) => [c.assignee, c.n]));
      expect(byUser.get(null as unknown as string)).toBeUndefined(); // none left pooled
      expect(byUser.get(A)).toBe(3);
      expect(byUser.get(B)).toBe(3);
      expect(byUser.get(C)).toBe(3);
    }
  }, 60000);

  it('IT-ASSIGN-002: least-load picks the lightest; Pending tickets are not counted', async () => {
    if (!ready) return;
    const Payroll = cat.get('Payroll')!;
    await configure(Payroll, 'least_load', [A, B, C]);

    const t0 = new Date('2026-06-01T00:00:00Z');
    for (let i = 0; i < 5; i++) await makeAssigned(Payroll, A, 'in_progress', t0); // A: 5 open
    await makeAssigned(Payroll, B, 'assigned', t0); // B: 1 open
    await makeAssigned(Payroll, C, 'open', t0); // C: 2 open ...
    await makeAssigned(Payroll, C, 'in_progress', t0);
    for (let i = 0; i < 4; i++) await makeAssigned(Payroll, C, 'pending', t0); // ...+4 Pending (ignored)

    const ticketId = await makePooled(Payroll);
    const res = await assignOne(ticketId, Payroll);
    expect(res.assigneeId).toBe(B); // load 1 < C's 2 < A's 5
    const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(t!.assigneeId).toBe(B);
    expect(t!.status).toBe('assigned');
  });

  it('IT-ASSIGN-003: away members skipped (AC3); whole roster away → pool (AC4)', async () => {
    if (!ready) return;
    const Payroll = cat.get('Payroll')!;
    await configure(Payroll, 'round_robin', [A, B, C]);

    // B is away today → RR skips B; A and C absorb 4 tickets (2 each).
    await harness!.db
      .update(users)
      .set({ awayFrom: sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`, awayTo: sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 1` })
      .where(eq(users.id, B));
    const ids = await Promise.all(Array.from({ length: 4 }, () => makePooled(Payroll)));
    for (const id of ids) await assignOne(id, Payroll); // sequential: deterministic A,C,A,C
    let assignees = (
      await harness!.db.select({ a: tickets.assigneeId }).from(tickets).where(inArray(tickets.id, ids))
    ).map((r) => r.a);
    expect(assignees).not.toContain(B);
    expect(assignees.filter((a) => a === A).length).toBe(2);
    expect(assignees.filter((a) => a === C).length).toBe(2);

    // B's away window expired (ended yesterday) → assignable again.
    await harness!.db
      .update(users)
      .set({
        awayFrom: sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 5`,
        awayTo: sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1`,
      })
      .where(eq(users.id, B));
    await harness!.db.delete(tickets);
    await harness!.db.delete(assignCursors);
    const more = await Promise.all(Array.from({ length: 3 }, () => makePooled(Payroll)));
    for (const id of more) await assignOne(id, Payroll);
    assignees = (
      await harness!.db.select({ a: tickets.assigneeId }).from(tickets).where(inArray(tickets.id, more))
    ).map((r) => r.a);
    expect(assignees).toContain(B); // B is back in rotation

    // AC4: everyone away → pool (no error, no wedge).
    await harness!.db
      .update(users)
      .set({ awayFrom: sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`, awayTo: null })
      .where(inArray(users.id, [A, B, C]));
    await harness!.db.delete(tickets);
    const pooled = await makePooled(Payroll);
    const res = await assignOne(pooled, Payroll);
    expect(res.assigneeId).toBeNull();
    expect(res.reason).toBe('pool_all_away');
    const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, pooled));
    expect(t!.assigneeId).toBeNull();
    expect(t!.status).toBe('open');
  });

  it('IT-ASSIGN-004: AUTO_ASSIGN_ENABLED=false kill-switch → everything pools', async () => {
    if (!ready) return;
    const Payroll = cat.get('Payroll')!;
    // A fully-configured, all-available roster that WOULD assign when the feature is on.
    await configure(Payroll, 'round_robin', [A, B, C]);

    const prev = process.env.AUTO_ASSIGN_ENABLED;
    process.env.AUTO_ASSIGN_ENABLED = 'false';
    try {
      const ticketId = await makePooled(Payroll);
      const res = await assignOne(ticketId, Payroll);
      expect(res.assigneeId).toBeNull();
      expect(res.reason).toBe('pool_feature_disabled');
      const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, ticketId));
      expect(t!.assigneeId).toBeNull(); // untouched → stays pooled
      expect(t!.status).toBe('open');
    } finally {
      // Restore so the default-on behaviour of the other suites is never affected.
      if (prev === undefined) delete process.env.AUTO_ASSIGN_ENABLED;
      else process.env.AUTO_ASSIGN_ENABLED = prev;
    }
  });
});
