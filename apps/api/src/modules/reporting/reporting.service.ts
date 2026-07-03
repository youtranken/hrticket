import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { DEFAULT_OVERDUE_DAYS } from '@hris/shared';
import { withActor } from '../../infra/db/with-actor';
import { tickets, categories, users, reminderConfig } from '../../infra/db/schema';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from '../tickets/actor';

/** Report window + slicing options (đơn 13). All optional except granularity default. */
export interface ReportOpts {
  from?: string;
  to?: string;
  /** by-time bucket size; ignored by by-category / by-staff. */
  granularity?: 'week' | 'month' | 'year';
  /** Slice to one handler (Admin/TL drill-down). A member is FORCED to self. */
  assigneeId?: string;
  /** Comparison window for the summary deltas (Report v2) — usually the same
   *  window shifted one year back ("so cùng kỳ"). */
  prevFrom?: string;
  prevTo?: string;
}

/**
 * Report aggregations (Story 10.3, FR83 → Report v2 redesign). Every query runs
 * under `withActor`, so the SAME tickets RLS that scopes the worklist also scopes
 * the numbers: a Team Lead sees only their category groups, an Admin the whole
 * project, an SSA the project named by `X-Project`. Junk is excluded everywhere
 * (FR103) except the explicit junk counter in `summary`. Day grouping uses
 * `created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'`, never UTC-date (AC1).
 *
 * Đơn 13: a MEMBER may call these too, but every method pins the assignee filter
 * to the member's own id (self-report) — RLS alone is NOT enough, because member
 * RLS shows the whole group, not just their own tickets.
 *
 * Known + INTENDED asymmetry (review 3/7, FR65): the member self-report counts
 * RLS-visible ∩ self, and the RLS keep-WIP carve-out excludes CLOSED tickets — so
 * a member removed from a group also loses their closed tickets there from their
 * OWN report, while an Admin slicing assigneeId=<them> still counts everything.
 * That is need-to-know working as designed (đóng/chuyển người = mất quyền), not a
 * counting bug; do NOT "fix" it by running member reports as system actor.
 *
 * Report v2 semantics — ONE window everywhere: tickets CREATED in [from, to].
 * "handled" = status resolved|closed now; "active/holding" = neither; overdue is
 * the read-time flag (5.6). Handling time = resolved_at − created_at (trigger-
 * stamped; NULL — e.g. pre-backfill resolved rows — is excluded from averages).
 *
 * (Mail held by the mail-bomb gate never becomes a ticket — its `suppressed`
 * status lives on inbox_messages, not on tickets — so there's nothing extra to
 * exclude here beyond `is_junk`.)
 */
@Injectable()
export class ReportingService {
  /** Shared overdue predicate — the EXACT mirror of tickets-read 5.6 `overdueExprs()`
   *  (review 3/7: the first cut skipped the snooze rules and the numbers diverged
   *  from the worklist): resolved/closed never overdue, snoozed-and-still-waiting
   *  exempt, snoozed PAST the date measured FROM snooze_until. Read-time `now()`. */
  private overdueParts() {
    const threshold = sql`COALESCE(${reminderConfig.overdueDays}, ${DEFAULT_OVERDUE_DAYS})`;
    const vnToday = sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
    const base = sql`CASE WHEN ${tickets.status} = 'pending' AND ${tickets.snoozeUntil} IS NOT NULL AND ${tickets.snoozeUntil} < ${vnToday} THEN ${tickets.snoozeUntil}::timestamptz ELSE ${tickets.lastOpenedAt} END`;
    const ageDays = sql`floor(extract(epoch from (now() - (${base})))/86400)`;
    const snoozedWaiting = sql`(${tickets.status} = 'pending' AND ${tickets.snoozeUntil} IS NOT NULL AND ${tickets.snoozeUntil} >= ${vnToday})`;
    const isOverdue = sql<boolean>`(${tickets.status} NOT IN ('resolved','closed') AND NOT ${snoozedWaiting} AND (${ageDays}) > (${threshold}))`;
    /** Days the WORST overdue ticket is past the threshold (0 when none). */
    const maxOverdueDays = sql<number>`COALESCE(max((${ageDays}) - (${threshold})) FILTER (WHERE ${isOverdue}), 0)::int`;
    return { isOverdue, maxOverdueDays };
  }

  /** Handling time in days (resolved_at − created_at); NULL until resolved. */
  private handleDaysExpr() {
    return sql`extract(epoch from (${tickets.resolvedAt} - ${tickets.createdAt}))/86400.0`;
  }

  /** A member only ever reports on THEMSELVES; other roles may slice by assignee. */
  private effectiveAssignee(user: SessionUser, opts: ReportOpts): string | undefined {
    return user.role === 'member' ? user.id : opts.assigneeId;
  }

  /** WHERE common to every report: project + junk-excluded + created within window
   *  + optional assignee slice. */
  private baseWhere(projectId: number, opts: { from?: string; to?: string }, assigneeId?: string) {
    const conds: SQL[] = [eq(tickets.projectId, projectId), eq(tickets.isJunk, false)];
    if (assigneeId) conds.push(eq(tickets.assigneeId, assigneeId));
    // Window on creation, in VN time (consistent with the day grouping).
    if (opts.from)
      conds.push(gte(tickets.createdAt, sql`(${opts.from}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`));
    if (opts.to) {
      conds.push(
        lte(
          tickets.createdAt,
          sql`((${opts.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '1 microsecond'`,
        ),
      );
    }
    return and(...conds);
  }

  /** Counts grouped by week / month / year (VN time). FR83 / AC1 + đơn 13. */
  async byTime(user: SessionUser, projectId: number, opts: ReportOpts = {}) {
    const actor = await actorForUser(user);
    const overdue = this.overdueParts().isOverdue;
    const vnCreated = sql`${tickets.createdAt} AT TIME ZONE 'Asia/Ho_Chi_Minh'`;
    const g = opts.granularity ?? 'month';
    // Labels sort lexically in chronological order for all three shapes
    // ('2026-W07' < '2026-W20', '2026-01' < '2026-12', '2025' < '2026').
    const bucket =
      g === 'week'
        ? sql<string>`to_char(date_trunc('week', ${vnCreated}), 'IYYY-"W"IW')`
        : g === 'year'
          ? sql<string>`to_char(date_trunc('year', ${vnCreated}), 'YYYY')`
          : sql<string>`to_char(date_trunc('month', ${vnCreated}), 'YYYY-MM')`;
    const assignee = this.effectiveAssignee(user, opts);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          bucket,
          created: sql<number>`count(*)::int`,
          handled: sql<number>`count(*) FILTER (WHERE ${tickets.status} IN ('resolved','closed'))::int`,
          closed: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'closed')::int`,
          open: sql<number>`count(*) FILTER (WHERE ${tickets.status} NOT IN ('resolved','closed'))::int`,
          overdue: sql<number>`count(*) FILTER (WHERE ${overdue})::int`,
          reopened: sql<number>`count(*) FILTER (WHERE ${tickets.reopenCount} > 0)::int`,
        })
        .from(tickets)
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(this.baseWhere(projectId, opts, assignee))
        .groupBy(bucket)
        .orderBy(bucket);
      return { buckets: rows };
    });
  }

  /** Counts grouped by category. FR83. */
  async byCategory(user: SessionUser, projectId: number, opts: ReportOpts = {}) {
    const actor = await actorForUser(user);
    const overdue = this.overdueParts().isOverdue;
    const assignee = this.effectiveAssignee(user, opts);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          categoryId: tickets.categoryId,
          nameVi: categories.nameVi,
          nameEn: categories.nameEn,
          created: sql<number>`count(*)::int`,
          handled: sql<number>`count(*) FILTER (WHERE ${tickets.status} IN ('resolved','closed'))::int`,
          closed: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'closed')::int`,
          open: sql<number>`count(*) FILTER (WHERE ${tickets.status} NOT IN ('resolved','closed'))::int`,
          overdue: sql<number>`count(*) FILTER (WHERE ${overdue})::int`,
        })
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(this.baseWhere(projectId, opts, assignee))
        .groupBy(tickets.categoryId, categories.nameVi, categories.nameEn)
        .orderBy(sql`count(*) DESC`);
      return { categories: rows };
    });
  }

  /** Per-staff scoreboard (Report v2). Grouped by the CURRENT assignee (FR31/AC2 —
   *  a ticket reassigned from X to Y counts for Y only); pool (null assignee) is
   *  its own "unassigned" row so totals reconcile. `handled` = resolved+closed,
   *  `holding` = still active, plus handling-time quality metrics. */
  async byStaff(user: SessionUser, projectId: number, opts: ReportOpts = {}) {
    const actor = await actorForUser(user);
    const overdue = this.overdueParts().isOverdue;
    const assignee = this.effectiveAssignee(user, opts);
    const handleDays = this.handleDaysExpr();
    const threshold = sql`COALESCE(${reminderConfig.overdueDays}, ${DEFAULT_OVERDUE_DAYS})`;
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          assigneeId: tickets.assigneeId,
          name: users.name,
          holding: sql<number>`count(*) FILTER (WHERE ${tickets.status} NOT IN ('resolved','closed'))::int`,
          handled: sql<number>`count(*) FILTER (WHERE ${tickets.status} IN ('resolved','closed'))::int`,
          overdue: sql<number>`count(*) FILTER (WHERE ${overdue})::int`,
          avgDays: sql<
            number | null
          >`(avg(${handleDays}) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL))::float8`,
          onTimePct: sql<number | null>`(CASE
            WHEN count(*) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL) = 0 THEN NULL
            ELSE 100.0 * count(*) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL AND (${handleDays}) <= (${threshold}))
                 / count(*) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL)
          END)::float8`,
        })
        .from(tickets)
        .leftJoin(users, eq(users.id, tickets.assigneeId))
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(this.baseWhere(projectId, opts, assignee))
        .groupBy(tickets.assigneeId, users.name)
        .orderBy(
          sql`count(*) FILTER (WHERE ${tickets.status} IN ('resolved','closed')) DESC`,
          sql`count(*) DESC`,
        );
      return { staff: rows };
    });
  }

  /** One-shot header numbers for the dashboard (Report v2): KPI cards, current
   *  status distribution, quality strip, year range. All windowed on created_at
   *  like everything else; `prevFrom/prevTo` yields the comparison deltas. */
  async summary(user: SessionUser, projectId: number, opts: ReportOpts = {}) {
    const actor = await actorForUser(user);
    const assignee = this.effectiveAssignee(user, opts);
    const overdue = this.overdueParts().isOverdue;
    const handleDays = this.handleDaysExpr();
    const threshold = sql`COALESCE(${reminderConfig.overdueDays}, ${DEFAULT_OVERDUE_DAYS})`;
    const vnToday = sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

    return withActor(actor, async (tx) => {
      const mainSelect = {
        total: sql<number>`count(*)::int`,
        stOpen: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'open')::int`,
        stAssigned: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'assigned')::int`,
        stInProgress: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'in_progress')::int`,
        stPending: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'pending')::int`,
        stResolved: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'resolved')::int`,
        stClosed: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'closed')::int`,
        reopenedActive: sql<number>`count(*) FILTER (WHERE ${tickets.status} NOT IN ('resolved','closed') AND ${tickets.reopenCount} > 0)::int`,
        reopenedAll: sql<number>`count(*) FILTER (WHERE ${tickets.reopenCount} > 0)::int`,
        // `<=` — a follow-up dated TODAY is already due (mirrors tickets-read 5.6).
        snoozeDue: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'pending' AND ${tickets.snoozeUntil} IS NOT NULL AND ${tickets.snoozeUntil} <= ${vnToday})::int`,
        overdueTotal: sql<number>`count(*) FILTER (WHERE ${overdue})::int`,
        maxOverdueDays: this.overdueParts().maxOverdueDays,
        avgDays: sql<
          number | null
        >`(avg(${handleDays}) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL))::float8`,
        onTimePct: sql<number | null>`(CASE
          WHEN count(*) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL) = 0 THEN NULL
          ELSE 100.0 * count(*) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL AND (${handleDays}) <= (${threshold}))
               / count(*) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL)
        END)::float8`,
      };
      const [cur] = await tx
        .select(mainSelect)
        .from(tickets)
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(this.baseWhere(projectId, opts, assignee));

      // Comparison window (usually same period last year) — only the delta inputs.
      let prev: { handled: number; avgDays: number | null } | null = null;
      if (opts.prevFrom || opts.prevTo) {
        const [p] = await tx
          .select({
            handled: sql<number>`count(*) FILTER (WHERE ${tickets.status} IN ('resolved','closed'))::int`,
            avgDays: sql<
              number | null
            >`(avg(${handleDays}) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL))::float8`,
          })
          .from(tickets)
          .where(this.baseWhere(projectId, { from: opts.prevFrom, to: opts.prevTo }, assignee));
        prev = { handled: p?.handled ?? 0, avgDays: p?.avgDays ?? null };
      }

      // Junk blocked in the window — the ONE number where junk is the subject (no
      // junk exclusion). The assignee slice STILL applies (review 3/7: junk keeps its
      // original category, so member RLS sees the whole group's junk — without the
      // pin a member's self-report leaks a group-wide count).
      const junkConds: SQL[] = [eq(tickets.projectId, projectId), eq(tickets.isJunk, true)];
      if (assignee) junkConds.push(eq(tickets.assigneeId, assignee));
      if (opts.from)
        junkConds.push(gte(tickets.createdAt, sql`(${opts.from}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`));
      if (opts.to)
        junkConds.push(
          lte(
            tickets.createdAt,
            sql`((${opts.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '1 microsecond'`,
          ),
        );
      const [junkRow] = await tx
        .select({ junk: sql<number>`count(*)::int` })
        .from(tickets)
        .where(and(...junkConds));

      // First year with any data → the FE year picker. Pinned like everything else
      // (review 3/7): a member's picker starts at THEIR first ticket, not the
      // project's — the project-wide minimum would leak history past the self-pin.
      const [yearRow] = await tx
        .select({
          minYear: sql<
            number | null
          >`min(extract(year from ${tickets.createdAt} AT TIME ZONE 'Asia/Ho_Chi_Minh'))::int`,
        })
        .from(tickets)
        .where(
          assignee
            ? and(eq(tickets.projectId, projectId), eq(tickets.assigneeId, assignee))
            : eq(tickets.projectId, projectId),
        );

      const c = cur!;
      return {
        total: c.total,
        status: {
          open: c.stOpen,
          assigned: c.stAssigned,
          inProgress: c.stInProgress,
          pending: c.stPending,
          resolved: c.stResolved,
          closed: c.stClosed,
        },
        handled: { total: c.stResolved + c.stClosed, resolved: c.stResolved, closed: c.stClosed },
        active: {
          total: c.total - c.stResolved - c.stClosed,
          reopened: c.reopenedActive,
          pending: c.stPending,
          snoozeDue: c.snoozeDue,
        },
        overdue: { total: c.overdueTotal, maxDays: c.maxOverdueDays },
        resolution: { avgDays: c.avgDays, onTimePct: c.onTimePct },
        quality: { reopenedAll: c.reopenedAll, junk: junkRow?.junk ?? 0, snoozeDue: c.snoozeDue },
        prev,
        minYear: yearRow?.minYear ?? null,
      };
    });
  }
}
