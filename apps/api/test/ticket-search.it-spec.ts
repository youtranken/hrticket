import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { tickets, ticketMessages, categories, userGroupMembership, users } from '../src/infra/db/schema';
import { TicketSearchService } from '../src/modules/tickets/ticket-search.service';
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
 * IT-SEARCH-001..003 — Story 10.2 (FR81). Vietnamese FTS (simple + unaccent,
 * 2-way diacritic-insensitive), code + people search, visibility via ticket-join
 * RLS, and the GIN-index EXPLAIN gate. Self-skips without Docker.
 */
describe('IT-SEARCH: Vietnamese full-text search', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new TicketSearchService();

  let Payroll: number;
  let Insurance: number;
  let adminU: SessionUser;
  let memberPayrollU: SessionUser; // in Payroll group only

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, en: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      Payroll = cats.find((c) => c.en === 'Payroll')!.id;
      Insurance = cats.find((c) => c.en !== 'Payroll' && c.en !== 'Other')?.id ?? cats.find((c) => c.en !== 'Payroll')!.id;

      const admin = (await makeUser(harness.db, { projectId: HRIS, email: 'adm-search@t.local', role: 'admin' }))!;
      const mem = (await makeUser(harness.db, { projectId: HRIS, email: 'mem-search@t.local', role: 'member' }))!;
      adminU = asSession(admin);
      memberPayrollU = asSession(mem);
      await harness.db.insert(userGroupMembership).values({ userId: mem.id, categoryId: Payroll });

      ready = true;
    } catch (e) {
      console.warn('[IT-SEARCH] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  let seq = 0;
  async function mkTicket(opts: {
    code?: string;
    subject: string;
    requesterEmail?: string;
    categoryId?: number;
    assigneeId?: string | null;
    body?: string;
    bodyInternal?: boolean;
  }): Promise<string> {
    seq += 1;
    const [t] = await harness!.db
      .insert(tickets)
      .values({
        projectId: HRIS,
        ticketCode: opts.code ?? `#S${String(seq).padStart(4, '0')}`,
        subject: opts.subject,
        requesterEmail: opts.requesterEmail ?? 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: opts.categoryId ?? Payroll,
        status: 'open',
        assigneeId: opts.assigneeId ?? null,
      })
      .returning({ id: tickets.id });
    if (opts.body !== undefined) {
      await harness!.db.insert(ticketMessages).values({
        ticketId: t!.id,
        direction: 'inbound',
        isInternal: opts.bodyInternal ?? false,
        fromAddr: opts.requesterEmail ?? 'r@x.com',
        bodyText: opts.body,
      });
    }
    return t!.id;
  }

  it('IT-SEARCH-001: "nghỉ phép" ↔ "nghi phep" match 2-way (A.7), with headline', async () => {
    if (!ready) return;
    // Ticket 1: diacritics in the subject. Ticket 2: no-diacritics in the body.
    const t1 = await mkTicket({ subject: 'Xin nghỉ phép tháng 7' });
    const t2 = await mkTicket({ subject: 'Yeu cau khac', body: 'nghi phep di du lich he nay' });

    for (const query of ['nghi phep', 'nghỉ phép']) {
      const res = await svc.search(adminU, query, 1, 50);
      const ids = res.items.map((i) => i.id);
      expect(ids).toContain(t1); // matched via subject
      expect(ids).toContain(t2); // matched via body
      // The subject hit carries a <b>-wrapped headline.
      const hit1 = res.items.find((i) => i.id === t1)!;
      expect(hit1.headline).toMatch(/<b>/);
    }
  });

  it('IT-SEARCH-004: manual column sort — created asc/desc override relevance (#20)', async () => {
    if (!ready) return;
    const older = await mkTicket({ subject: 'sortprobe alpha' });
    const newer = await mkTicket({ subject: 'sortprobe beta' });
    await harness!.db
      .update(tickets)
      .set({ createdAt: new Date('2025-01-01T00:00:00Z') })
      .where(eq(tickets.id, older));

    const asc = await svc.search(adminU, 'sortprobe', 1, 20, { sort: 'created', dir: 'asc' });
    const ascIds = asc.items.map((i) => i.id);
    expect(ascIds.indexOf(older)).toBeLessThan(ascIds.indexOf(newer));

    const desc = await svc.search(adminU, 'sortprobe', 1, 20, { sort: 'created', dir: 'desc' });
    const descIds = desc.items.map((i) => i.id);
    expect(descIds.indexOf(newer)).toBeLessThan(descIds.indexOf(older));
  });

  it('IT-SEARCH-002: code & people search; out-of-group → no match (AC2/AC3)', async () => {
    if (!ready) return;
    const named = (await makeUser(harness!.db, { projectId: HRIS, email: 'nva@t.local', role: 'member' }))!;
    // Give the named user a recognizable diacritic name.
    await harness!.db.update(users).set({ name: 'Nguyễn Văn A' }).where(eq(users.id, named.id));

    const coded = await mkTicket({ code: '#00012', subject: 'Salary question' });
    const assigned = await mkTicket({ subject: 'Assigned to NVA', assigneeId: named.id });

    // Code: "#00012", "00012", "12" all surface the coded ticket first.
    for (const q of ['#00012', '00012', '12']) {
      const res = await svc.search(adminU, q, 1, 20);
      expect(res.items[0]?.id).toBe(coded);
      expect(res.items[0]?.matchType).toBe('code');
    }

    // People: the diacritic name found by an unaccented query.
    const byName = await svc.search(adminU, 'nguyen van a', 1, 20);
    expect(byName.items.map((i) => i.id)).toContain(assigned);

    // AC3 — a Payroll member searches a term that ONLY matches an Insurance ticket
    // (out of their group) → zero results, no leak; an internal note there is hidden too.
    await mkTicket({
      subject: 'Bao hiem xyzzysecret',
      categoryId: Insurance,
      body: 'noi dung note xyzzysecret',
      bodyInternal: true,
    });
    const leak = await svc.search(memberPayrollU, 'xyzzysecret', 1, 20);
    expect(leak.items).toHaveLength(0);
    expect(leak.total).toBe(0);
  });

  it('IT-SEARCH-003: search uses the GIN index, not a seq scan (AC4 gate)', async () => {
    if (!ready) return;
    // Bulk-seed ~10k tickets so the planner prefers the index. Single multi-row
    // INSERT keeps it fast.
    // Bulk subjects all share generic non-matching text; a handful of "needles"
    // carry a RARE token. A selective predicate is what makes the planner prefer
    // the GIN index over a seq scan (a low-selectivity term legitimately seq-scans,
    // which is correct planner behaviour, not an index failure).
    const rows: { projectId: number; ticketCode: string; subject: string; requesterEmail: string; mailbox: string; categoryId: number; status: 'open' }[] = [];
    for (let i = 0; i < 10000; i++) {
      const isNeedle = i % 2000 === 0; // ~5 needles in 10k
      rows.push({
        projectId: HRIS,
        ticketCode: `#B${String(i).padStart(6, '0')}`,
        subject: isNeedle ? 'Xin nghi phep zzqrareneedle' : 'Cau hoi luong thuong nien',
        requesterEmail: 'bulk@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: 'open',
      });
    }
    // Chunk the insert to stay within parameter limits.
    for (let i = 0; i < rows.length; i += 1000) {
      await harness!.db.insert(tickets).values(rows.slice(i, i + 1000));
    }
    await harness!.sql`ANALYZE tickets`;

    // The FTS predicate must be SERVED BY the GIN index (idx_tickets_search), not a
    // full table scan. At 10k rows a seq scan can be marginally cheaper, and that's
    // legitimate planner behaviour — so we assert the index is USABLE for this
    // predicate by disqualifying seq-scan, then confirming the planner reaches for
    // the GIN index (it physically cannot if the index is missing/wrong). This is
    // deterministic (no machine-dependent cost race) — the CI gate. The p95<500ms
    // figure stays a manual benchmark (story A11).
    const text = await harness!.sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const rows = await tx`
        EXPLAIN (FORMAT TEXT)
        SELECT id FROM tickets
        WHERE search_tsv @@ websearch_to_tsquery('simple', f_unaccent('zzqrareneedle'))
      `;
      return (rows as Record<string, string>[]).map((r) => Object.values(r)[0]).join('\n');
    });
    expect(text).toMatch(/idx_tickets_search|Bitmap Index Scan/i);
    expect(text).not.toMatch(/Seq Scan on tickets/i);
  });
});
