import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { withActor, systemActor, type DbTx } from '../../infra/db/with-actor';
import { viewLog, tickets, users, attachments, userGroupMembership } from '../../infra/db/schema';
import type { SessionUser } from '../auth/session.service';

export interface AuditFilters {
  from?: string; // ISO datetime lower bound (inclusive)
  to?: string; // ISO datetime upper bound (inclusive)
  actorId?: string;
  action?: string; // exact action, e.g. 'ticket.reopened'
  objectType?: string; // e.g. 'ticket' | 'category' | 'user'
  ticketId?: string; // object_id of a ticket (AC1 — one ticket's lifecycle)
  categoryId?: number; // ticket-logs whose ticket is in this category
  page: number;
  pageSize: number;
}

export interface AuditRow {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  objectType: string | null;
  objectId: string | null;
  oldValue: unknown;
  newValue: unknown;
}

export interface ViewLogFilters {
  ticketId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

/**
 * Story 9.5 (FR66–FR72) — read side of the audit + sensitive view-log. The tables
 * carry no RLS (audit_log is custom; view_log is plain), so every query runs as the
 * system actor with the scope enforced HARD in the WHERE:
 *  - Admin → own project (incl. config logs)
 *  - SSA → the active project (X-Project; may switch between the two)
 *  - Team Lead → ONLY ticket-logs whose ticket is in one of their category groups
 *    (never config/user logs, never other groups)
 *  - Member → 403 (no menu, enforced at the controller)
 * audit_log is append-only at the DB level (REVOKE UPDATE/DELETE) — there is no
 * mutate endpoint here at all.
 */
@Injectable()
export class AuditService {
  /** Category ids a team lead may see logs for (their group memberships). */
  private async leadGroups(tx: DbTx, userId: string): Promise<number[]> {
    const mem = await tx
      .select({ categoryId: userGroupMembership.categoryId })
      .from(userGroupMembership)
      .where(eq(userGroupMembership.userId, userId));
    return mem.map((m) => m.categoryId);
  }

  async list(
    actor: SessionUser,
    projectId: number,
    f: AuditFilters,
  ): Promise<{ items: AuditRow[]; total: number; page: number; pageSize: number }> {
    if (actor.role === 'member') throw new ForbiddenException();
    return withActor(systemActor, async (tx) => {
      const conds: ReturnType<typeof sql>[] = [sql`project_id = ${projectId}`];

      // Team-lead scope: only ticket-logs for tickets in their groups.
      if (actor.role === 'team_lead') {
        const groups = await this.leadGroups(tx, actor.id);
        if (groups.length === 0) {
          return { items: [], total: 0, page: f.page, pageSize: f.pageSize };
        }
        conds.push(sql`object_type = 'ticket'`);
        conds.push(sql`object_id IN (
          SELECT id::text FROM tickets
          WHERE project_id = ${projectId}
            AND category_id IN (${sql.join(groups.map((g) => sql`${g}`), sql`, `)})
        )`);
      }

      if (f.from) conds.push(sql`created_at >= ${f.from}`);
      if (f.to) conds.push(sql`created_at <= ${f.to}`);
      if (f.actorId) conds.push(sql`actor_id = ${f.actorId}`);
      if (f.action) conds.push(sql`action = ${f.action}`);
      if (f.objectType) conds.push(sql`object_type = ${f.objectType}`);
      if (f.ticketId) conds.push(sql`(object_type = 'ticket' AND object_id = ${f.ticketId})`);
      if (f.categoryId !== undefined) {
        conds.push(sql`object_type = 'ticket'`);
        conds.push(sql`object_id IN (SELECT id::text FROM tickets WHERE category_id = ${f.categoryId})`);
      }

      const where = sql.join(conds, sql` AND `);
      const offset = (f.page - 1) * f.pageSize;

      const rows = (await tx.execute(sql`
        SELECT id::text AS id, created_at, actor_id, actor_label, action,
               object_type, object_id, old_value, new_value
        FROM audit_log
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${f.pageSize} OFFSET ${offset}
      `)) as unknown as Array<Record<string, unknown>>;

      const countRows = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM audit_log WHERE ${where}
      `)) as unknown as Array<{ n: number }>;

      const items: AuditRow[] = rows.map((r) => ({
        id: String(r.id),
        createdAt: new Date(r.created_at as string).toISOString(),
        actorId: (r.actor_id as string) ?? null,
        actorLabel: (r.actor_label as string) ?? null,
        action: r.action as string,
        objectType: (r.object_type as string) ?? null,
        objectId: (r.object_id as string) ?? null,
        oldValue: r.old_value ?? null,
        newValue: r.new_value ?? null,
      }));
      return { items, total: Number(countRows[0]?.n ?? 0), page: f.page, pageSize: f.pageSize };
    });
  }

  async viewLogList(
    actor: SessionUser,
    projectId: number,
    f: ViewLogFilters,
  ): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
    if (actor.role === 'member') throw new ForbiddenException();
    return withActor(systemActor, async (tx) => {
      const conds = [eq(tickets.projectId, projectId)];
      if (actor.role === 'team_lead') {
        const groups = await this.leadGroups(tx, actor.id);
        if (groups.length === 0) return { items: [], total: 0, page: f.page, pageSize: f.pageSize };
        conds.push(inArray(tickets.categoryId, groups));
      }
      if (f.ticketId) conds.push(eq(viewLog.ticketId, f.ticketId));
      if (f.actorId) conds.push(eq(viewLog.actorId, f.actorId));
      if (f.from) conds.push(gte(viewLog.createdAt, new Date(f.from)));
      if (f.to) conds.push(lte(viewLog.createdAt, new Date(f.to)));

      const where = and(...conds);
      const offset = (f.page - 1) * f.pageSize;

      const rows = await tx
        .select({
          id: viewLog.id,
          createdAt: viewLog.createdAt,
          action: viewLog.action,
          actorId: viewLog.actorId,
          actorName: users.name,
          actorEmail: users.email,
          ticketId: viewLog.ticketId,
          ticketCode: tickets.ticketCode,
          attachmentId: viewLog.attachmentId,
          fileName: attachments.fileName,
        })
        .from(viewLog)
        .innerJoin(tickets, eq(tickets.id, viewLog.ticketId))
        .innerJoin(users, eq(users.id, viewLog.actorId))
        .leftJoin(attachments, eq(attachments.id, viewLog.attachmentId))
        .where(where)
        .orderBy(desc(viewLog.createdAt))
        .limit(f.pageSize)
        .offset(offset);

      const [c] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(viewLog)
        .innerJoin(tickets, eq(tickets.id, viewLog.ticketId))
        .where(where);

      const items = rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      }));
      return { items, total: Number(c?.n ?? 0), page: f.page, pageSize: f.pageSize };
    });
  }
}
