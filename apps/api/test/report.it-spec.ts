import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { tickets, categories, userGroupMembership } from '../src/infra/db/schema';
import { ReportingService } from '../src/modules/reporting/reporting.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const HRIS = 1;

function asSession(row: {
  id: string;
  email: string;
  name: string;
  role: string;
  projectId: number | null;
}): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as SessionUser['role'],
    projectId: row.projectId,
    disabled: false,
    mustChangePassword: false,
  };
}

/**
 * IT-REPORT-001..002 — Story 10.3 (FR83). VN-day grouping (a 23:30 VN ticket on
 * the last of the month counts in THAT month, not the next via UTC), workload by
 * the actual handler (current assignee), role-scoped visibility, and junk
 * exclusion. Self-skips without Docker.
 */
describe('IT-REPORT: report dashboard aggregations', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new ReportingService();

  let Payroll: number;
  let Insurance: number;
  let adminU: SessionUser;
  let tlPayrollU: SessionUser;
  let memberXU: SessionUser;
  let X: { id: string; name: string };
  let Y: { id: string; name: string };

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, en: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      Payroll = cats.find((c) => c.en === 'Payroll')!.id;
      Insurance = cats.find((c) => c.en !== 'Payroll' && c.en !== 'Other')?.id ?? cats.find((c) => c.en !== 'Payroll')!.id;

      const admin = (await makeUser(harness.db, { projectId: HRIS, email: 'adm-rpt@t.local', role: 'admin' }))!;
      const tl = (await makeUser(harness.db, { projectId: HRIS, email: 'tl-rpt@t.local', role: 'team_lead' }))!;
      const x = (await makeUser(harness.db, { projectId: HRIS, email: 'x-rpt@t.local', role: 'member' }))!;
      const y = (await makeUser(harness.db, { projectId: HRIS, email: 'y-rpt@t.local', role: 'member' }))!;
      adminU = asSession(admin);
      tlPayrollU = asSession(tl);
      memberXU = asSession(x);
      X = { id: x.id, name: x.name };
      Y = { id: y.id, name: y.name };
      // TL is in Payroll only → reports must show Payroll only for them.
      await harness.db.insert(userGroupMembership).values({ userId: tl.id, categoryId: Payroll });
      // Member X is in Payroll too — the self-report pin (đơn 13) must beat the
      // group-wide RLS visibility, so being in a group is the interesting case.
      await harness.db.insert(userGroupMembership).values({ userId: x.id, categoryId: Payroll });

      ready = true;
    } catch (e) {
      console.warn('[IT-REPORT] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(tickets);
  });

  let seq = 0;
  async function mk(opts: {
    createdAt: Date;
    categoryId?: number;
    assigneeId?: string | null;
    status?: string;
    isJunk?: boolean;
    resolvedAt?: Date;
    snoozeUntil?: string;
  }): Promise<string> {
    seq += 1;
    const [t] = await harness!.db
      .insert(tickets)
      .values({
        projectId: HRIS,
        ticketCode: `#R${String(seq).padStart(5, '0')}`,
        subject: `report ${seq}`,
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: opts.categoryId ?? Payroll,
        status: (opts.status ?? 'open') as 'open',
        assigneeId: opts.assigneeId ?? null,
        isJunk: opts.isJunk ?? false,
        createdAt: opts.createdAt,
        resolvedAt: opts.resolvedAt ?? null,
        snoozeUntil: opts.snoozeUntil ?? null,
      })
      .returning({ id: tickets.id });
    return t!.id;
  }

  it('IT-REPORT-001: VN-day month grouping (boundary) + workload by actual handler', async () => {
    if (!ready) return;
    // 23:30 VN on 31 July 2026 == 16:30 UTC 31 July. Must count in JULY (2026-07).
    const julyBoundary = new Date('2026-07-31T16:30:00Z');
    await mk({ createdAt: julyBoundary, assigneeId: Y.id });
    // A clearly-August ticket (10 Aug) for contrast.
    await mk({ createdAt: new Date('2026-08-10T03:00:00Z'), assigneeId: Y.id });

    const time = await svc.byTime(adminU, HRIS, { from: '2026-01-01', to: '2026-12-31' });
    const july = time.buckets.find((b) => b.bucket === '2026-07');
    const aug = time.buckets.find((b) => b.bucket === '2026-08');
    expect(july?.created).toBe(1); // the boundary ticket lands in July, not August
    expect(aug?.created).toBe(1);

    // AC2 — workload by the CURRENT assignee. Both tickets end on Y (a reassign
    // X→Y leaves assignee_id = Y), so Y is counted, X is not. Both still open →
    // they show under `holding` (Report v2: `handled` = resolved/closed only).
    const staff = await svc.byStaff(adminU, HRIS, { from: '2026-01-01', to: '2026-12-31' });
    const yRow = staff.staff.find((s) => s.assigneeId === Y.id);
    const xRow = staff.staff.find((s) => s.assigneeId === X.id);
    expect(yRow?.holding).toBe(2);
    expect(yRow?.handled).toBe(0);
    expect(xRow).toBeUndefined(); // X never the final handler → absent
  });

  it('IT-REPORT-002: role scope (TL→own group) + junk excluded everywhere', async () => {
    if (!ready) return;
    const when = new Date('2026-05-15T03:00:00Z');
    await mk({ createdAt: when, categoryId: Payroll });
    await mk({ createdAt: when, categoryId: Insurance });
    await mk({ createdAt: when, categoryId: Payroll, isJunk: true }); // junk → excluded

    // Admin sees both categories; junk excluded → Payroll=1 (not 2), Insurance=1.
    const adminCat = await svc.byCategory(adminU, HRIS, { from: '2026-01-01', to: '2026-12-31' });
    const adminPayroll = adminCat.categories.find((c) => c.categoryId === Payroll);
    const adminInsurance = adminCat.categories.find((c) => c.categoryId === Insurance);
    expect(adminPayroll?.created).toBe(1); // the junk Payroll ticket is NOT counted
    expect(adminInsurance?.created).toBe(1);

    // TL (Payroll group only) sees Payroll, never Insurance (RLS).
    const tlCat = await svc.byCategory(tlPayrollU, HRIS, { from: '2026-01-01', to: '2026-12-31' });
    expect(tlCat.categories.find((c) => c.categoryId === Payroll)?.created).toBe(1);
    expect(tlCat.categories.find((c) => c.categoryId === Insurance)).toBeUndefined();

    // Junk never appears in by-time either.
    const time = await svc.byTime(adminU, HRIS, { from: '2026-01-01', to: '2026-12-31' });
    const may = time.buckets.find((b) => b.bucket === '2026-05');
    expect(may?.created).toBe(2); // Payroll + Insurance, junk excluded
  });

  it('IT-REPORT-003 (đơn 13): member is pinned to a SELF report even inside their group', async () => {
    if (!ready) return;
    const when = new Date('2026-05-15T03:00:00Z');
    await mk({ createdAt: when, categoryId: Payroll, assigneeId: X.id });
    await mk({ createdAt: when, categoryId: Payroll, assigneeId: Y.id }); // same group — RLS would show it
    await mk({ createdAt: when, categoryId: Payroll, assigneeId: null }); // pool

    const range = { from: '2026-01-01', to: '2026-12-31' };
    // Member X sees ONLY the ticket assigned to X — not the groupmate's, not the pool.
    const time = await svc.byTime(memberXU, HRIS, range);
    expect(time.buckets.reduce((a, b) => a + b.created, 0)).toBe(1);
    // ...even if they try to smuggle someone else's assigneeId in.
    const forged = await svc.byCategory(memberXU, HRIS, { ...range, assigneeId: Y.id });
    expect(forged.categories.reduce((a, c) => a + c.created, 0)).toBe(1);
    const staff = await svc.byStaff(memberXU, HRIS, range);
    expect(staff.staff).toHaveLength(1);
    expect(staff.staff[0]!.assigneeId).toBe(X.id);

    // Admin slicing by assignee (the user filter) narrows every table to that user.
    const adminSlice = await svc.byStaff(adminU, HRIS, { ...range, assigneeId: Y.id });
    expect(adminSlice.staff).toHaveLength(1);
    expect(adminSlice.staff[0]!.assigneeId).toBe(Y.id);
  });

  it('IT-REPORT-004 (đơn 13): week / year granularity buckets (VN time)', async () => {
    if (!ready) return;
    // 15 May 2026 10:00 VN = ISO week 2026-W20; 18 May (Monday) = 2026-W21.
    await mk({ createdAt: new Date('2026-05-15T03:00:00Z') });
    await mk({ createdAt: new Date('2026-05-18T03:00:00Z') });

    const range = { from: '2026-01-01', to: '2026-12-31' };
    const weekly = await svc.byTime(adminU, HRIS, { ...range, granularity: 'week' });
    expect(weekly.buckets.map((b) => b.bucket)).toEqual(['2026-W20', '2026-W21']);

    const yearly = await svc.byTime(adminU, HRIS, { ...range, granularity: 'year' });
    expect(yearly.buckets).toHaveLength(1);
    expect(yearly.buckets[0]!.bucket).toBe('2026');
    expect(yearly.buckets[0]!.created).toBe(2);
  });

  it('IT-REPORT-005 (Report v2): summary — states, handled, avg days, prev delta, member pin, junk', async () => {
    if (!ready) return;
    const mayVN = (d: number, h = 3) => new Date(Date.UTC(2026, 4, d, h)); // 10:00 VN
    // Current-year mix: 1 closed (2 days), 1 resolved (4 days), 1 open (X's),
    // 1 pending past its follow-up date, 1 junk (excluded except the junk counter).
    await mk({ createdAt: mayVN(1), status: 'closed', resolvedAt: mayVN(3), assigneeId: Y.id });
    await mk({ createdAt: mayVN(1), status: 'resolved', resolvedAt: mayVN(5), assigneeId: Y.id });
    await mk({ createdAt: mayVN(10), status: 'open', assigneeId: X.id });
    await mk({ createdAt: mayVN(10), status: 'pending', snoozeUntil: '2026-05-20', assigneeId: Y.id });
    await mk({ createdAt: mayVN(12), isJunk: true });
    // Last year: 1 closed → prev.handled = 1, and minYear = 2025.
    await mk({
      createdAt: new Date(Date.UTC(2025, 4, 10, 3)),
      status: 'closed',
      resolvedAt: new Date(Date.UTC(2025, 4, 11, 3)),
    });

    const s = await svc.summary(adminU, HRIS, {
      from: '2026-01-01',
      to: '2026-12-31',
      prevFrom: '2025-01-01',
      prevTo: '2025-12-31',
    });
    expect(s.total).toBe(4); // junk excluded
    expect(s.handled).toEqual({ total: 2, resolved: 1, closed: 1 });
    expect(s.status.open).toBe(1);
    expect(s.status.pending).toBe(1);
    expect(s.active.total).toBe(2);
    expect(s.active.snoozeDue).toBe(1); // 2026-05-20 is in the past at test time
    expect(s.resolution.avgDays).toBeCloseTo(3.0, 1); // (2 + 4) / 2
    expect(s.quality.junk).toBe(1);
    expect(s.prev).toEqual({ handled: 1, avgDays: expect.closeTo(1.0, 1) });
    expect(s.minYear).toBe(2025);

    // Member pin: X only ever sees their own single open ticket — including the
    // junk counter and the year-picker floor (review 3/7: both leaked group-wide).
    const ms = await svc.summary(memberXU, HRIS, { from: '2026-01-01', to: '2026-12-31' });
    expect(ms.total).toBe(1);
    expect(ms.active.total).toBe(1);
    expect(ms.handled.total).toBe(0);
    expect(ms.quality.junk).toBe(0); // the project junk ticket is NOT theirs
    expect(ms.minYear).toBe(2026); // 2025 data exists but is not theirs
  });

  it('IT-REPORT-006 (Report v2): resolved_at trigger stamps on resolve, clears on reopen', async () => {
    if (!ready) return;
    const id = await mk({ createdAt: new Date('2026-05-15T03:00:00Z'), status: 'in_progress', assigneeId: Y.id });

    await harness!.db.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, id));
    let [row] = await harness!.db
      .select({ resolvedAt: tickets.resolvedAt })
      .from(tickets)
      .where(eq(tickets.id, id));
    expect(row!.resolvedAt).not.toBeNull();

    // Reopen (resolved → in_progress) clears it so a re-resolution restamps.
    await harness!.db.update(tickets).set({ status: 'in_progress' }).where(eq(tickets.id, id));
    [row] = await harness!.db.select({ resolvedAt: tickets.resolvedAt }).from(tickets).where(eq(tickets.id, id));
    expect(row!.resolvedAt).toBeNull();
  });
});
