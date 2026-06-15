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
      X = { id: x.id, name: x.name };
      Y = { id: y.id, name: y.name };
      // TL is in Payroll only → reports must show Payroll only for them.
      await harness.db.insert(userGroupMembership).values({ userId: tl.id, categoryId: Payroll });

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

    const time = await svc.byTime(adminU, HRIS, '2026-01-01', '2026-12-31');
    const july = time.buckets.find((b) => b.bucket === '2026-07');
    const aug = time.buckets.find((b) => b.bucket === '2026-08');
    expect(july?.created).toBe(1); // the boundary ticket lands in July, not August
    expect(aug?.created).toBe(1);

    // AC2 — workload by the CURRENT assignee. Both tickets end on Y (a reassign
    // X→Y leaves assignee_id = Y), so Y is counted, X is not.
    const staff = await svc.byStaff(adminU, HRIS, '2026-01-01', '2026-12-31');
    const yRow = staff.staff.find((s) => s.assigneeId === Y.id);
    const xRow = staff.staff.find((s) => s.assigneeId === X.id);
    expect(yRow?.handled).toBe(2);
    expect(xRow).toBeUndefined(); // X never the final handler → absent
  });

  it('IT-REPORT-002: role scope (TL→own group) + junk excluded everywhere', async () => {
    if (!ready) return;
    const when = new Date('2026-05-15T03:00:00Z');
    await mk({ createdAt: when, categoryId: Payroll });
    await mk({ createdAt: when, categoryId: Insurance });
    await mk({ createdAt: when, categoryId: Payroll, isJunk: true }); // junk → excluded

    // Admin sees both categories; junk excluded → Payroll=1 (not 2), Insurance=1.
    const adminCat = await svc.byCategory(adminU, HRIS, '2026-01-01', '2026-12-31');
    const adminPayroll = adminCat.categories.find((c) => c.categoryId === Payroll);
    const adminInsurance = adminCat.categories.find((c) => c.categoryId === Insurance);
    expect(adminPayroll?.created).toBe(1); // the junk Payroll ticket is NOT counted
    expect(adminInsurance?.created).toBe(1);

    // TL (Payroll group only) sees Payroll, never Insurance (RLS).
    const tlCat = await svc.byCategory(tlPayrollU, HRIS, '2026-01-01', '2026-12-31');
    expect(tlCat.categories.find((c) => c.categoryId === Payroll)?.created).toBe(1);
    expect(tlCat.categories.find((c) => c.categoryId === Insurance)).toBeUndefined();

    // Junk never appears in by-time either.
    const time = await svc.byTime(adminU, HRIS, '2026-01-01', '2026-12-31');
    const may = time.buckets.find((b) => b.bucket === '2026-05');
    expect(may?.created).toBe(2); // Payroll + Insurance, junk excluded
  });
});
