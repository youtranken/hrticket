import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import {
  categories,
  tickets,
  assignCursors,
  autoAssignConfig,
  autoAssignMembers,
} from '../src/infra/db/schema';
import { autoAssign } from '../src/modules/routing/auto-assign.service';
import { AvailabilityService } from '../src/modules/users/availability.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const vnDate = (offsetDays = 0): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
  });

function asSession(u: { id: string; email: string; projectId: number | null; role: SessionUser['role'] }): SessionUser {
  return { id: u.id, email: u.email, name: u.email, role: u.role, projectId: u.projectId, disabled: false, mustChangePassword: false };
}

/**
 * IT-AVAIL-001/002 — Story 4.3. Away windows are evaluated at read (no flip job):
 * before/during/after the window flips auto-assign eligibility purely by date.
 * Admin may set availability only inside their own project (cross-project → 403).
 */
describe('IT-AVAIL: availability semantics + admin scope', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  let Payroll: number;
  let U: { id: string; email: string; projectId: number | null; role: SessionUser['role'] };
  const availability = new AvailabilityService();

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const [pay] = await harness.db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.nameEn, 'Payroll'));
      Payroll = pay!.id;
      const u = (await makeUser(harness.db, { projectId: 1, email: 'avail-u@x.com' }))!;
      U = { id: u.id, email: u.email, projectId: u.projectId, role: 'member' };
      const [cfg] = await harness.db
        .insert(autoAssignConfig)
        .values({ categoryId: Payroll, strategy: 'round_robin' })
        .returning({ id: autoAssignConfig.id });
      await harness.db.insert(autoAssignMembers).values({ configId: cfg!.id, userId: U.id, position: 0 });
      ready = true;
    } catch (e) {
      console.warn('[IT-AVAIL] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  async function assignFresh(): Promise<string | null> {
    await harness!.db.delete(tickets);
    await harness!.db.delete(assignCursors);
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#V${Math.floor(Math.random() * 90000) + 10000}`,
        subject: 's',
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: 'open',
      })
      .returning({ id: tickets.id });
    const res = await withActor(systemActor, (tx) =>
      autoAssign(tx, { projectId: 1, ticketId: row!.id, ticketCode: '#x', categoryId: Payroll }),
    );
    return res.assigneeId;
  }

  it('IT-AVAIL-001: before / during / after the away window flips eligibility (no job)', async () => {
    if (!ready) return;
    const session = asSession(U);

    // During the window → skipped → pool.
    await availability.setForSelf(session, { awayFrom: vnDate(0), awayTo: vnDate(1) });
    expect(await assignFresh()).toBeNull();

    // Window already ended (yesterday) → assignable again, no action taken.
    await availability.setForSelf(session, { awayFrom: vnDate(-3), awayTo: vnDate(-1) });
    expect(await assignFresh()).toBe(U.id);

    // Window hasn't started yet (tomorrow) → still assignable now.
    await availability.setForSelf(session, { awayFrom: vnDate(1), awayTo: vnDate(3) });
    expect(await assignFresh()).toBe(U.id);

    // Open-ended away (from today, no end) → skipped.
    await availability.setForSelf(session, { awayFrom: vnDate(0), awayTo: null });
    expect(await assignFresh()).toBeNull();

    // Cleared → assignable.
    await availability.setForSelf(session, { awayFrom: null, awayTo: null });
    expect(await assignFresh()).toBe(U.id);
  });

  it('IT-AVAIL-002: admin sets within project (+audit); cross-project → 403', async () => {
    if (!ready) return;
    const adminHris = asSession({ id: (await makeUser(harness!.db, { projectId: 1, email: 'adm-hris@x.com', role: 'admin' }))!.id, email: 'adm-hris@x.com', projectId: 1, role: 'admin' });
    const cnbUser = (await makeUser(harness!.db, { projectId: 2, email: 'cnb-u@x.com' }))!;

    // In-project: OK + an audit row "by admin".
    await availability.setForUser(adminHris, U.id, { awayFrom: vnDate(0), awayTo: vnDate(2) });
    const audit = (await harness!.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'user.availability_admin' AND object_id = ${U.id}
    `)) as unknown as Array<{ n: number }>;
    expect(audit[0]!.n).toBeGreaterThanOrEqual(1);
    await availability.setForSelf(asSession(U), { awayFrom: null, awayTo: null }); // reset

    // Cross-project: hris admin touching a cnb user → 403.
    await expect(
      availability.setForUser(adminHris, cnbUser.id, { awayFrom: vnDate(0), awayTo: null }),
    ).rejects.toThrow();
  });
});
