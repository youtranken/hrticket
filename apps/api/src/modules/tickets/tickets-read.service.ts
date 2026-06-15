import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { DEFAULT_OVERDUE_DAYS } from '@hris/shared';
import { withActor } from '../../infra/db/with-actor';
import { alias } from 'drizzle-orm/pg-core';
import type { TicketListQuery } from './dto/ticket-list.query';
import {
  tickets,
  ticketMessages,
  participants,
  attachments,
  tags,
  ticketTags,
  ticketLink,
  categories,
  projects,
  users,
  reminderConfig,
} from '../../infra/db/schema';

/**
 * Overdue / snooze SQL, computed server-side so FE has ONE source of truth (5.6).
 * `now()` is the DB clock — tests move time by back-dating rows, never the clock
 * (CLAUDE.md). Snoozed-and-still-waiting tickets are excluded; a snoozed ticket past
 * its date is measured FROM the snooze date (5.5/C5); Resolved/Closed never overdue.
 */
const VN_TODAY = sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
function overdueExprs() {
  const threshold = sql`COALESCE(${reminderConfig.overdueDays}, ${DEFAULT_OVERDUE_DAYS})`;
  const base = sql`CASE WHEN ${tickets.status} = 'pending' AND ${tickets.snoozeUntil} IS NOT NULL AND ${tickets.snoozeUntil} < ${VN_TODAY} THEN ${tickets.snoozeUntil}::timestamptz ELSE ${tickets.lastOpenedAt} END`;
  const ageDays = sql`floor(extract(epoch from (now() - (${base})))/86400)`;
  const snoozedWaiting = sql`(${tickets.status} = 'pending' AND ${tickets.snoozeUntil} IS NOT NULL AND ${tickets.snoozeUntil} >= ${VN_TODAY})`;
  const isOverdue = sql<boolean>`(${tickets.status} NOT IN ('resolved','closed') AND NOT ${snoozedWaiting} AND (${ageDays}) > (${threshold}))`;
  const overdueDays = sql<number>`(CASE WHEN ${tickets.status} NOT IN ('resolved','closed') AND NOT ${snoozedWaiting} AND (${ageDays}) > (${threshold}) THEN ((${ageDays}) - (${threshold}))::int ELSE 0 END)`;
  const snoozeDue = sql<boolean>`(${tickets.status} = 'pending' AND ${tickets.snoozeUntil} IS NOT NULL AND ${tickets.snoozeUntil} <= ${VN_TODAY})`;
  return { isOverdue, overdueDays, snoozeDue };
}
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';
import { signedFileUrl } from '../../infra/crypto/signed-url';
import { writeTicketViewLog } from '../files/view-log';

/** Replace the stable inline-image placeholders left by the sanitizer (3.7) with
 *  freshly-signed, short-lived URLs at READ time (a stored token would be stale). */
function signInlineImages(html: string | null, userId: string): string | null {
  if (!html) return html;
  return html.replace(
    /\/api\/files\/([0-9a-fA-F-]{36})(?!\?)/g,
    (_m, id: string) => signedFileUrl(id, userId),
  );
}

export interface TicketAssignee {
  id: string;
  name: string;
  awayFrom: string | null;
  awayTo: string | null;
}

export interface TicketListItem {
  id: string;
  ticketCode: string;
  projectKey: string;
  subject: string;
  requesterEmail: string;
  status: string;
  category: { vi: string; en: string } | null;
  assignee: TicketAssignee | null;
  tags: { name: string; color: string | null }[];
  createdAt: Date;
  isOverdue: boolean;
  overdueDays: number;
  snoozeUntil: string | null;
  snoozeDue: boolean;
}

export type TicketView = 'all' | 'pool' | 'mine' | 'pending';

export interface TicketListResult {
  items: TicketListItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Count of overdue tickets in scope (header badge — Story 5.6). */
  overdueTotal: number;
}

/** One ticket row for export (Story 10.4) — flat, no pagination metadata. */
export interface TicketExportRow {
  ticketCode: string;
  projectKey: string;
  subject: string;
  categoryVi: string | null;
  categoryEn: string | null;
  status: string;
  requesterEmail: string;
  assigneeName: string | null;
  tags: string[];
  createdAt: Date;
  closedAt: Date | null;
  isOverdue: boolean;
  overdueDays: number;
  reopenCount: number;
}

/**
 * The worklist ORDER BY (Story 10.1, FR106) — the SQL twin of the shared
 * `compareWorklist` in `packages/shared/worklist-order.ts`. ONE spec, two
 * implementations; an equivalence test (IT-LIST-001) proves they never drift.
 *
 *   ① snooze due now        → snooze_due     DESC  (due-today first)
 *   ② overdue               → is_overdue     DESC
 *   ③ more overdue first    → overdue_days   DESC
 *   ④ recently assigned     → assigned_at    DESC NULLS LAST (pool sinks)
 *   ⑤ by age (oldest first) → last_opened_at ASC
 *   ⑥ stable final tiebreak → id             ASC
 */
function worklistOrderBy(ov: ReturnType<typeof overdueExprs>): SQL[] {
  return [
    sql`${ov.snoozeDue} DESC`,
    sql`${ov.isOverdue} DESC`,
    sql`${ov.overdueDays} DESC`,
    sql`${tickets.assignedAt} DESC NULLS LAST`,
    sql`${tickets.lastOpenedAt} ASC`,
    sql`${tickets.id} ASC`,
  ];
}

@Injectable()
export class TicketsReadService {
  /** Paginated, RLS-filtered ticket list. Default order = the shared worklist
   *  spec (FR106); filters (FR79) ride on top of RLS, which stays the safety net
   *  (out-of-scope filter → empty page, never a leak). The `view` narrows to the
   *  group pool / my tickets (Story 4.4) or the Pending tab (Story 10.1). */
  async list(user: SessionUser, q: TicketListQuery): Promise<TicketListResult> {
    const actor = await actorForUser(user);
    const { page, pageSize } = q;
    const offset = (page - 1) * pageSize;
    const assignee = alias(users, 'assignee');
    const ov = overdueExprs();
    return withActor(actor, async (tx) => {
      const filter = this.buildFilter(user, q);
      const orderBy = this.buildOrder(q, ov);

      const rows = await tx
        .select({
          id: tickets.id,
          ticketCode: tickets.ticketCode,
          projectKey: projects.key,
          subject: tickets.subject,
          requesterEmail: tickets.requesterEmail,
          status: tickets.status,
          categoryVi: categories.nameVi,
          categoryEn: categories.nameEn,
          assigneeId: assignee.id,
          assigneeName: assignee.name,
          assigneeAwayFrom: assignee.awayFrom,
          assigneeAwayTo: assignee.awayTo,
          createdAt: tickets.createdAt,
          snoozeUntil: tickets.snoozeUntil,
          isOverdue: ov.isOverdue,
          overdueDays: ov.overdueDays,
          snoozeDue: ov.snoozeDue,
        })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(assignee, eq(assignee.id, tickets.assigneeId))
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(filter)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset);

      const countRows = await tx
        .select({
          count: sql<number>`count(*)::int`,
          overdue: sql<number>`count(*) FILTER (WHERE ${ov.isOverdue})::int`,
        })
        .from(tickets)
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(filter);
      const total = countRows[0]?.count ?? 0;
      const overdueTotal = countRows[0]?.overdue ?? 0;

      const ids = rows.map((r) => r.id);
      const tagRows = ids.length
        ? await tx
            .select({ ticketId: ticketTags.ticketId, name: tags.name, color: tags.color })
            .from(ticketTags)
            .innerJoin(tags, eq(tags.id, ticketTags.tagId))
            .where(inArray(ticketTags.ticketId, ids))
        : [];

      const items: TicketListItem[] = rows.map((r) => ({
        id: r.id,
        ticketCode: r.ticketCode,
        projectKey: r.projectKey,
        subject: r.subject,
        requesterEmail: r.requesterEmail,
        status: r.status,
        category: r.categoryVi ? { vi: r.categoryVi, en: r.categoryEn! } : null,
        assignee: r.assigneeId
          ? {
              id: r.assigneeId,
              name: r.assigneeName!,
              awayFrom: r.assigneeAwayFrom,
              awayTo: r.assigneeAwayTo,
            }
          : null,
        tags: tagRows.filter((t) => t.ticketId === r.id).map((t) => ({ name: t.name, color: t.color })),
        createdAt: r.createdAt,
        isOverdue: r.isOverdue,
        overdueDays: r.overdueDays,
        snoozeUntil: r.snoozeUntil,
        snoozeDue: r.snoozeDue,
      }));

      return { items, total, page, pageSize, overdueTotal };
    });
  }

  /** Full filtered ticket set for export (Story 10.4) — SAME RLS + filters as the
   *  worklist (reuses buildFilter), but no pagination. Returns up to `limit`+1 rows
   *  so the caller can detect "over the cap" and 422 without a silent cut (AC3). */
  async listForExport(
    user: SessionUser,
    q: TicketListQuery,
    limit: number,
  ): Promise<TicketExportRow[]> {
    const actor = await actorForUser(user);
    const assignee = alias(users, 'assignee');
    const ov = overdueExprs();
    return withActor(actor, async (tx) => {
      const filter = this.buildFilter(user, q);
      const orderBy = this.buildOrder(q, ov);
      const rows = await tx
        .select({
          id: tickets.id,
          ticketCode: tickets.ticketCode,
          projectKey: projects.key,
          subject: tickets.subject,
          requesterEmail: tickets.requesterEmail,
          status: tickets.status,
          categoryVi: categories.nameVi,
          categoryEn: categories.nameEn,
          assigneeName: assignee.name,
          createdAt: tickets.createdAt,
          closedAt: tickets.closedAt,
          isOverdue: ov.isOverdue,
          overdueDays: ov.overdueDays,
          reopenCount: tickets.reopenCount,
        })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(assignee, eq(assignee.id, tickets.assigneeId))
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(filter)
        .orderBy(...orderBy)
        .limit(limit + 1); // +1 sentinel → caller detects > limit

      const ids = rows.map((r) => r.id);
      const tagRows = ids.length
        ? await tx
            .select({ ticketId: ticketTags.ticketId, name: tags.name })
            .from(ticketTags)
            .innerJoin(tags, eq(tags.id, ticketTags.tagId))
            .where(inArray(ticketTags.ticketId, ids))
        : [];
      return rows.map((r) => ({
        ticketCode: r.ticketCode,
        projectKey: r.projectKey,
        subject: r.subject,
        categoryVi: r.categoryVi,
        categoryEn: r.categoryEn,
        status: r.status,
        requesterEmail: r.requesterEmail,
        assigneeName: r.assigneeName,
        tags: tagRows.filter((t) => t.ticketId === r.id).map((t) => t.name),
        createdAt: r.createdAt,
        closedAt: r.closedAt,
        isOverdue: r.isOverdue,
        overdueDays: r.overdueDays,
        reopenCount: r.reopenCount,
      }));
    });
  }

  /** Combine the view (pool/mine/pending) with the explicit filter bar (FR79).
   *  RLS already scopes visibility, so this only narrows — never widens. */
  private buildFilter(user: SessionUser, q: TicketListQuery): SQL | undefined {
    const conds: SQL[] = [];

    // View tab.
    if (q.view === 'pool') {
      conds.push(and(isNull(tickets.assigneeId), eq(tickets.status, 'open'))!);
    } else if (q.view === 'mine') {
      conds.push(eq(tickets.assigneeId, user.id));
    } else if (q.view === 'pending') {
      // Pending tab: snoozed tickets only (status pending with a snooze date set).
      conds.push(and(eq(tickets.status, 'pending'), sql`${tickets.snoozeUntil} IS NOT NULL`)!);
    }

    // Status (multi). Ignored in the pending view (already pinned to pending).
    if (q.view !== 'pending' && q.status?.length) {
      conds.push(inArray(tickets.status, q.status));
    }
    if (q.categoryId?.length) conds.push(inArray(tickets.categoryId, q.categoryId));
    if (q.assigneeId?.length) conds.push(inArray(tickets.assigneeId, q.assigneeId));
    // SSA may scope to one project; project-scoped roles are already pinned by RLS.
    if (q.projectId !== undefined && user.role === 'ssa') {
      conds.push(eq(tickets.projectId, q.projectId));
    }
    // Tag filter: ticket carries the tag (EXISTS subquery).
    if (q.tagId?.length) {
      const ids = sql.join(
        q.tagId.map((id) => sql`${id}`),
        sql`, `,
      );
      conds.push(
        sql`EXISTS (SELECT 1 FROM ticket_tags tt WHERE tt.ticket_id = ${tickets.id} AND tt.tag_id IN (${ids}))`,
      );
    }
    // Created-at range — boundaries computed in Asia/Ho_Chi_Minh (lead's rule;
    // consistent with the report day-grouping), not UTC-date.
    if (q.createdFrom) {
      conds.push(gte(tickets.createdAt, sql`(${q.createdFrom}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`));
    }
    if (q.createdTo) {
      // Inclusive of the whole VN day → strictly before the next VN midnight.
      conds.push(
        lte(
          tickets.createdAt,
          sql`((${q.createdTo}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '1 microsecond'`,
        ),
      );
    }

    if (conds.length === 0) return undefined;
    return conds.length === 1 ? conds[0] : and(...conds);
  }

  /** Default order = shared worklist spec (FR106). The Pending tab and manual
   *  column sorts override it; the "Về thứ tự chuẩn" button just drops back to
   *  the default `sort=worklist`. */
  private buildOrder(q: TicketListQuery, ov: ReturnType<typeof overdueExprs>): SQL[] {
    if (q.view === 'pending') {
      // Pending tab: nearest snooze date first by default (FR80). The "oldest"
      // toggle is the explicit `sort=snooze&dir=desc`; everything else = nearest.
      const oldest = q.sort === 'snooze' && q.dir === 'desc';
      return [oldest ? desc(tickets.snoozeUntil) : asc(tickets.snoozeUntil), asc(tickets.id)];
    }
    if (q.sort === 'created') return [q.dir === 'asc' ? asc(tickets.createdAt) : desc(tickets.createdAt), asc(tickets.id)];
    if (q.sort === 'status') return [q.dir === 'asc' ? asc(tickets.status) : desc(tickets.status), asc(tickets.id)];
    if (q.sort === 'snooze') return [q.dir === 'asc' ? asc(tickets.snoozeUntil) : desc(tickets.snoozeUntil), asc(tickets.id)];
    return worklistOrderBy(ov);
  }

  /** Options for the filter bar (Story 10.1) — derived from the actor's VISIBLE
   *  tickets, so they're inherently RLS-scoped (no out-of-group category/assignee/
   *  tag can leak into the dropdowns). Distinct categories, assignees, tags. */
  async filterOptions(user: SessionUser): Promise<{
    categories: { id: number; nameVi: string; nameEn: string }[];
    assignees: { id: string; name: string }[];
    tags: { id: number; name: string; color: string | null }[];
  }> {
    const actor = await actorForUser(user);
    const assignee = alias(users, 'assignee');
    return withActor(actor, async (tx) => {
      const cats = await tx
        .selectDistinct({ id: categories.id, nameVi: categories.nameVi, nameEn: categories.nameEn })
        .from(tickets)
        .innerJoin(categories, eq(categories.id, tickets.categoryId));
      const asg = await tx
        .selectDistinct({ id: assignee.id, name: assignee.name })
        .from(tickets)
        .innerJoin(assignee, eq(assignee.id, tickets.assigneeId));
      const tg = await tx
        .selectDistinct({ id: tags.id, name: tags.name, color: tags.color })
        .from(tickets)
        .innerJoin(ticketTags, eq(ticketTags.ticketId, tickets.id))
        .innerJoin(tags, eq(tags.id, ticketTags.tagId));
      return {
        categories: cats.sort((a, b) => a.nameEn.localeCompare(b.nameEn)),
        assignees: asg.filter((a): a is { id: string; name: string } => a.id !== null).sort((a, b) => a.name.localeCompare(b.name)),
        tags: tg.sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
  }

  /** Full ticket with conversation, participants, tags, attachment metadata, links.
   *  Invisible (RLS) → 404, no existence leak. Body is plain-text for now (HTML
   *  sanitisation is Story 3.7). FR12/FR19. */
  async getDetail(user: SessionUser, id: string) {
    const actor = await actorForUser(user);
    const assignee = alias(users, 'assignee');
    const ov = overdueExprs();
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          id: tickets.id,
          ticketCode: tickets.ticketCode,
          projectKey: projects.key,
          projectName: projects.name,
          subject: tickets.subject,
          requesterEmail: tickets.requesterEmail,
          status: tickets.status,
          categoryVi: categories.nameVi,
          categoryEn: categories.nameEn,
          categoryId: tickets.categoryId,
          categorySensitive: categories.isSensitive,
          assigneeId: assignee.id,
          assigneeName: assignee.name,
          assigneeAwayFrom: assignee.awayFrom,
          assigneeAwayTo: assignee.awayTo,
          createdAt: tickets.createdAt,
          snoozeUntil: tickets.snoozeUntil,
          reopenCount: tickets.reopenCount,
          reopenLocked: tickets.reopenLocked,
          isJunk: tickets.isJunk,
          isSpamThread: tickets.isSpamThread,
          isOverdue: ov.isOverdue,
          overdueDays: ov.overdueDays,
          snoozeDue: ov.snoozeDue,
        })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(assignee, eq(assignee.id, tickets.assigneeId))
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, tickets.projectId))
        .where(eq(tickets.id, id));
      if (!t) throw new NotFoundException('Ticket not found');

      // View-log a read of a SENSITIVE ticket (Story 8.3, FR67/NFR5) — server-side so
      // it can't be bypassed; deduped 5 min inside the helper. Non-sensitive: no row.
      if (t.categorySensitive) {
        await writeTicketViewLog(tx, { actorId: user.id, ticketId: id });
      }

      const messages = await tx
        .select({
          id: ticketMessages.id,
          direction: ticketMessages.direction,
          fromAddr: ticketMessages.fromAddr,
          toAddrs: ticketMessages.toAddrs,
          ccAddrs: ticketMessages.ccAddrs,
          bccAddrs: ticketMessages.bccAddrs,
          bodyText: ticketMessages.bodyText,
          bodyHtmlSafe: ticketMessages.bodyHtmlSafe,
          isAutoReply: ticketMessages.isAutoReply,
          isInternal: ticketMessages.isInternal,
          createdAt: ticketMessages.createdAt,
        })
        .from(ticketMessages)
        .where(eq(ticketMessages.ticketId, id))
        .orderBy(asc(ticketMessages.createdAt));

      const ppl = await tx
        .select({ id: participants.id, email: participants.email, status: participants.status })
        .from(participants)
        .where(eq(participants.ticketId, id));

      const tg = await tx
        .select({ name: tags.name, color: tags.color })
        .from(ticketTags)
        .innerJoin(tags, eq(tags.id, ticketTags.tagId))
        .where(eq(ticketTags.ticketId, id));

      const att = await tx
        .select({
          id: attachments.id,
          fileName: attachments.fileName,
          mimeType: attachments.mimeType,
          size: attachments.size,
          status: attachments.status,
        })
        .from(attachments)
        .where(eq(attachments.ticketId, id));

      // Cross-post / linked tickets (the other side of each link), if visible.
      const linkRows = await tx
        .select({ a: ticketLink.ticketA, b: ticketLink.ticketB, kind: ticketLink.kind })
        .from(ticketLink)
        .where(or(eq(ticketLink.ticketA, id), eq(ticketLink.ticketB, id)));
      const otherIds = linkRows.map((l) => (l.a === id ? l.b : l.a));
      const linkedTickets = otherIds.length
        ? await tx
            .select({ id: tickets.id, ticketCode: tickets.ticketCode, projectKey: projects.key })
            .from(tickets)
            .innerJoin(projects, eq(projects.id, tickets.projectId))
            .where(inArray(tickets.id, otherIds))
        : [];

      return {
        ticket: {
          id: t.id,
          ticketCode: t.ticketCode,
          projectKey: t.projectKey,
          projectName: t.projectName,
          subject: t.subject,
          requesterEmail: t.requesterEmail,
          status: t.status,
          category: t.categoryVi ? { vi: t.categoryVi, en: t.categoryEn! } : null,
          categoryId: t.categoryId,
          assignee: t.assigneeId
            ? {
                id: t.assigneeId,
                name: t.assigneeName!,
                awayFrom: t.assigneeAwayFrom,
                awayTo: t.assigneeAwayTo,
              }
            : null,
          createdAt: t.createdAt,
          snoozeUntil: t.snoozeUntil,
          reopenCount: t.reopenCount,
          reopenLocked: t.reopenLocked,
          isJunk: t.isJunk,
          isSpamThread: t.isSpamThread,
          isOverdue: t.isOverdue,
          overdueDays: t.overdueDays,
          snoozeDue: t.snoozeDue,
        },
        messages: messages.map((m) => ({ ...m, bodyHtmlSafe: signInlineImages(m.bodyHtmlSafe, user.id) })),
        participants: ppl,
        tags: tg,
        attachments: att,
        links: linkedTickets.map((l) => ({ ...l, kind: 'cross_post' })),
      };
    });
  }
}
