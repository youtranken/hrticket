import { eq } from 'drizzle-orm';
import {
  sortWorklist,
  WORKLIST_FIXTURE,
  WORKLIST_FIXTURE_ORDER,
  DEFAULT_OVERDUE_DAYS,
  type WorklistItem,
} from '@hris/shared';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { tickets, categories, userGroupMembership, ticketTags, tags } from '../src/infra/db/schema';
import { TicketsReadService } from '../src/modules/tickets/tickets-read.service';
import { ticketListQuerySchema, type TicketListQuery } from '../src/modules/tickets/dto/ticket-list.query';
import type { SessionUser } from '../src/modules/auth/session.service';

const HRIS = 1;
const DAY = 86_400_000;

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

/** A fully-defaulted query (what the controller's Zod parse yields for `?`). */
function q(overrides: Partial<TicketListQuery> = {}): TicketListQuery {
  return { ...ticketListQuerySchema.parse({}), ...overrides };
}

/**
 * IT-LIST-001..003 — Story 10.1. Worklist ordering (FR106) as SQL, the mandatory
 * equivalence with the shared TS sort, the full filter bar (FR79) + RLS safety
 * net (AC4), and the Pending tab (FR80). Self-skips when Docker is absent.
 */
describe('IT-LIST: worklist ordering + filters + pending', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const read = new TicketsReadService();

  let Payroll: number;
  let Insurance: number;
  let adminU: SessionUser;
  let memberU: SessionUser; // belongs to Payroll only
  let assigneeX = '';

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, en: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      Payroll = cats.find((c) => c.en === 'Payroll')!.id;
      // Any second non-system group for the out-of-scope test.
      Insurance = cats.find((c) => c.en !== 'Payroll' && c.en !== 'Other')?.id ?? cats.find((c) => c.en !== 'Payroll')!.id;

      const admin = (await makeUser(harness.db, { projectId: HRIS, email: 'adm-list@t.local', role: 'admin' }))!;
      const member = (await makeUser(harness.db, { projectId: HRIS, email: 'mem-list@t.local', role: 'member' }))!;
      const x = (await makeUser(harness.db, { projectId: HRIS, email: 'x-list@t.local', role: 'member' }))!;
      adminU = asSession(admin);
      memberU = asSession(member);
      assigneeX = x.id;
      await harness.db.insert(userGroupMembership).values({ userId: member.id, categoryId: Payroll });

      ready = true;
    } catch (e) {
      console.warn('[IT-LIST] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(ticketTags);
    await harness!.db.delete(tickets);
  });

  let seq = 0;
  /** Insert a ticket; `lastOpenedAt`/`assignedAt` are back-dated (never the clock). */
  async function mk(opts: {
    status?: string;
    categoryId?: number;
    assigneeId?: string | null;
    ageDays?: number; // last_opened_at = now - ageDays
    assignedDaysAgo?: number | null;
    snoozeUntil?: string | null;
  }): Promise<string> {
    seq += 1;
    const now = Date.now();
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: HRIS,
        ticketCode: `#L${String(seq).padStart(5, '0')}`,
        subject: `list ${seq}`,
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: opts.categoryId ?? Payroll,
        status: (opts.status ?? 'in_progress') as 'in_progress',
        assigneeId: opts.assigneeId ?? null,
        assignedAt:
          opts.assignedDaysAgo === null || opts.assignedDaysAgo === undefined
            ? null
            : new Date(now - opts.assignedDaysAgo * DAY),
        snoozeUntil: opts.snoozeUntil ?? null,
        lastOpenedAt: new Date(now - (opts.ageDays ?? 1) * DAY),
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  /** VN calendar date 'YYYY-MM-DD' offset by `days` from today. */
  function vnDate(days: number): string {
    const d = new Date(Date.now() + days * DAY);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  }

  it('IT-LIST-001a: the shared spec still yields its fixture order (drift guard)', () => {
    if (!ready) return;
    expect(sortWorklist(WORKLIST_FIXTURE).map((i) => i.id)).toEqual(WORKLIST_FIXTURE_ORDER);
  });

  it('IT-LIST-001b: SQL worklist order = A,B,C,D,E and matches the shared TS sort', async () => {
    if (!ready) return;
    const threshold = DEFAULT_OVERDUE_DAYS; // seeded reminder_config default = 3
    // A: snooze due today (pending, snooze = today). B: overdue 5 past threshold.
    // C: overdue 2 past threshold. D: fresh, assigned today. E: normal 1d old.
    const A = await mk({ status: 'pending', snoozeUntil: vnDate(0), assigneeId: assigneeX, assignedDaysAgo: 2, ageDays: 0 });
    const B = await mk({ status: 'in_progress', assigneeId: assigneeX, assignedDaysAgo: 4, ageDays: threshold + 5 });
    const C = await mk({ status: 'in_progress', assigneeId: assigneeX, assignedDaysAgo: 3, ageDays: threshold + 2 });
    const D = await mk({ status: 'assigned', assigneeId: assigneeX, assignedDaysAgo: 0, ageDays: 0 });
    const E = await mk({ status: 'in_progress', assigneeId: assigneeX, assignedDaysAgo: 1, ageDays: 1 });

    const res = await read.list(adminU, q({ pageSize: 100 }));
    const order = res.items.map((i) => i.id);
    expect(order).toEqual([A, B, C, D, E]);

    // ── Equivalence (mandatory): the shared TS sort over the SAME tickets must
    // produce the IDENTICAL order. Flags (snoozeDue/isOverdue/overdueDays) come
    // from the SQL list result (the server's source of truth); assignedAt /
    // lastOpenedAt come straight from the seeded DB columns. No hardcoded maps.
    const raw = await harness!.db
      .select({ id: tickets.id, assignedAt: tickets.assignedAt, lastOpenedAt: tickets.lastOpenedAt })
      .from(tickets);
    const rawById = new Map(raw.map((r) => [r.id, r] as const));
    const items: WorklistItem[] = res.items.map((i) => {
      const r = rawById.get(i.id)!;
      return {
        id: i.id,
        snoozeDue: i.snoozeDue,
        isOverdue: i.isOverdue,
        overdueDays: i.overdueDays,
        assignedAt: r.assignedAt ? r.assignedAt.getTime() : null,
        lastOpenedAt: r.lastOpenedAt.getTime(),
      };
    });
    expect(sortWorklist(items).map((i) => i.id)).toEqual(order);
  });

  it('IT-LIST-002: combined filters intersect + paginate; out-of-group → empty (AC4)', async () => {
    if (!ready) return;
    await harness!.db.delete(tags).where(eq(tags.name, 'it-list-filter-tag'));
    const [tag] = await harness!.db
      .insert(tags)
      .values({ projectId: HRIS, name: 'it-list-filter-tag', kind: 'manual' })
      .returning({ id: tags.id });

    const match = await mk({ status: 'in_progress', assigneeId: assigneeX, categoryId: Payroll });
    await mk({ status: 'open', assigneeId: assigneeX, categoryId: Payroll }); // wrong status
    await mk({ status: 'in_progress', assigneeId: null, categoryId: Payroll }); // wrong assignee
    await harness!.db.insert(ticketTags).values({ ticketId: match, tagId: tag!.id });

    const res = await read.list(
      adminU,
      q({ status: ['in_progress'], assigneeId: [assigneeX], tagId: [tag!.id], pageSize: 100 }),
    );
    expect(res.items.map((i) => i.id)).toEqual([match]);
    expect(res.total).toBe(1);

    // AC4 — member tampering with categoryId outside their group → empty, no throw.
    await mk({ status: 'in_progress', categoryId: Insurance });
    const leak = await read.list(memberU, q({ categoryId: [Insurance], pageSize: 100 }));
    expect(leak.items).toHaveLength(0);
    expect(leak.total).toBe(0);
  });

  it('IT-LIST-003: pending tab shows only snoozed, sorted by snooze date; woken leaves', async () => {
    if (!ready) return;
    const far = await mk({ status: 'pending', snoozeUntil: vnDate(10), assigneeId: assigneeX });
    const near = await mk({ status: 'pending', snoozeUntil: vnDate(2), assigneeId: assigneeX });
    await mk({ status: 'in_progress', assigneeId: assigneeX }); // not pending → excluded
    await mk({ status: 'pending', snoozeUntil: null, assigneeId: assigneeX }); // pending w/o snooze → excluded

    const res = await read.list(adminU, q({ view: 'pending', pageSize: 100 }));
    expect(res.items.map((i) => i.id)).toEqual([near, far]); // nearest due first
    expect(res.total).toBe(2);

    // "Wake" the near ticket (reply → in_progress) → it must drop out of the tab.
    await harness!.db.update(tickets).set({ status: 'in_progress', snoozeUntil: null }).where(eq(tickets.id, near));
    const after = await read.list(adminU, q({ view: 'pending', pageSize: 100 }));
    expect(after.items.map((i) => i.id)).toEqual([far]);
  });

  it('IT-LIST-004: filter-options are RLS-scoped (member sees only their group)', async () => {
    if (!ready) return;
    await mk({ status: 'in_progress', assigneeId: assigneeX, categoryId: Payroll });
    await mk({ status: 'in_progress', assigneeId: assigneeX, categoryId: Insurance });

    const adminOpts = await read.filterOptions(adminU);
    const adminCatIds = adminOpts.categories.map((c) => c.id);
    expect(adminCatIds).toEqual(expect.arrayContaining([Payroll, Insurance]));

    // The member is only in Payroll → Insurance must NOT appear in their options.
    const memberOpts = await read.filterOptions(memberU);
    const memberCatIds = memberOpts.categories.map((c) => c.id);
    expect(memberCatIds).toContain(Payroll);
    expect(memberCatIds).not.toContain(Insurance);
  });
});
