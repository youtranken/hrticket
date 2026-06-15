import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { DEFAULT_OVERDUE_DAYS } from '@hris/shared';
import { withActor } from '../../infra/db/with-actor';
import { tickets, categories, users, reminderConfig } from '../../infra/db/schema';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from '../tickets/actor';

/**
 * Report aggregations (Story 10.3, FR83). Every query runs under `withActor`, so
 * the SAME tickets RLS that scopes the worklist also scopes the numbers: a Team
 * Lead sees only their category groups, an Admin the whole project, an SSA the
 * project named by `X-Project`. Junk is excluded everywhere (FR103). Day grouping
 * uses `created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'`, never UTC-date (AC1).
 *
 * (Mail held by the mail-bomb gate never becomes a ticket — its `suppressed`
 * status lives on inbox_messages, not on tickets — so there's nothing extra to
 * exclude here beyond `is_junk`.)
 */
@Injectable()
export class ReportingService {
  /** Shared overdue predicate (mirrors tickets-read 5.6): open/non-closed past the
   *  project threshold. Read-time SQL `now()`. */
  private overdueExpr() {
    const threshold = sql`COALESCE(${reminderConfig.overdueDays}, ${DEFAULT_OVERDUE_DAYS})`;
    const ageDays = sql`floor(extract(epoch from (now() - ${tickets.lastOpenedAt}))/86400)`;
    return sql<boolean>`(${tickets.status} NOT IN ('resolved','closed') AND (${ageDays}) > (${threshold}))`;
  }

  /** WHERE common to every report: project + junk-excluded + created within window. */
  private baseWhere(projectId: number, from?: string, to?: string) {
    const conds = [eq(tickets.projectId, projectId), eq(tickets.isJunk, false)];
    // Window on creation, in VN time (consistent with the day grouping).
    if (from) conds.push(gte(tickets.createdAt, sql`(${from}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`));
    if (to) {
      conds.push(
        lte(
          tickets.createdAt,
          sql`((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '1 microsecond'`,
        ),
      );
    }
    return and(...conds);
  }

  /** Counts grouped by month (VN time). FR83 / AC1. */
  async byTime(user: SessionUser, projectId: number, from?: string, to?: string) {
    const actor = await actorForUser(user);
    const overdue = this.overdueExpr();
    const bucket = sql<string>`to_char(date_trunc('month', ${tickets.createdAt} AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM')`;
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          bucket,
          created: sql<number>`count(*)::int`,
          closed: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'closed')::int`,
          open: sql<number>`count(*) FILTER (WHERE ${tickets.status} NOT IN ('resolved','closed'))::int`,
          overdue: sql<number>`count(*) FILTER (WHERE ${overdue})::int`,
          reopened: sql<number>`count(*) FILTER (WHERE ${tickets.reopenCount} > 0)::int`,
        })
        .from(tickets)
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(this.baseWhere(projectId, from, to))
        .groupBy(bucket)
        .orderBy(bucket);
      return { buckets: rows };
    });
  }

  /** Counts grouped by category. FR83. */
  async byCategory(user: SessionUser, projectId: number, from?: string, to?: string) {
    const actor = await actorForUser(user);
    const overdue = this.overdueExpr();
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          categoryId: tickets.categoryId,
          nameVi: categories.nameVi,
          nameEn: categories.nameEn,
          created: sql<number>`count(*)::int`,
          closed: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'closed')::int`,
          open: sql<number>`count(*) FILTER (WHERE ${tickets.status} NOT IN ('resolved','closed'))::int`,
          overdue: sql<number>`count(*) FILTER (WHERE ${overdue})::int`,
        })
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(this.baseWhere(projectId, from, to))
        .groupBy(tickets.categoryId, categories.nameVi, categories.nameEn)
        .orderBy(sql`count(*) DESC`);
      return { categories: rows };
    });
  }

  /** Workload grouped by the ACTUAL handler = current assignee (FR31 / AC2). A
   *  ticket reassigned from X to Y counts for Y only. Pool (null assignee) is its
   *  own "unassigned" row so totals reconcile. */
  async byStaff(user: SessionUser, projectId: number, from?: string, to?: string) {
    const actor = await actorForUser(user);
    const overdue = this.overdueExpr();
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          assigneeId: tickets.assigneeId,
          name: users.name,
          handled: sql<number>`count(*)::int`,
          closed: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'closed')::int`,
          open: sql<number>`count(*) FILTER (WHERE ${tickets.status} NOT IN ('resolved','closed'))::int`,
          overdue: sql<number>`count(*) FILTER (WHERE ${overdue})::int`,
        })
        .from(tickets)
        .leftJoin(users, eq(users.id, tickets.assigneeId))
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(this.baseWhere(projectId, from, to))
        .groupBy(tickets.assigneeId, users.name)
        .orderBy(sql`count(*) DESC`);
      return { staff: rows };
    });
  }
}
