import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withActor } from '../../infra/db/with-actor';
import { tickets, categories, projects, users } from '../../infra/db/schema';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';

export type SearchMatchType = 'code' | 'subject' | 'body' | 'requester' | 'assignee';

export interface SearchResultItem {
  id: string;
  ticketCode: string;
  projectKey: string;
  subject: string;
  requesterEmail: string;
  status: string;
  category: { vi: string; en: string } | null;
  assignee: { id: string; name: string } | null;
  createdAt: Date;
  /** Why this ticket matched (code hits float to the very top). */
  matchType: SearchMatchType;
  /** ts_headline snippet over subject/body with the matched terms wrapped in <b>. */
  headline: string | null;
}

export interface SearchResult {
  items: SearchResultItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Extract the numeric part of a ticket-code query: `#00012` / `00012` / `12` → `12`. */
function parseCodeNumber(q: string): number | null {
  const m = q.trim().match(/^#?0*(\d{1,9})$/);
  return m ? Number(m[1]) : null;
}

/**
 * Vietnamese full-text + code + people search (Story 10.2, FR81).
 *
 * Diacritic-insensitive BOTH ways: the stored `search_tsv` columns and the query
 * are both run through `f_unaccent` + the `simple` config, so "nghỉ phép" ↔
 * "nghi phep" match symmetrically. Visibility = the `tickets` RLS join (there is
 * no message-level RLS): an out-of-group ticket is invisible, so neither its
 * subject, body, nor internal notes can ever surface (AC3).
 */
@Injectable()
export class TicketSearchService {
  async search(user: SessionUser, q: string, page = 1, pageSize = 20): Promise<SearchResult> {
    const actor = await actorForUser(user);
    const offset = (page - 1) * pageSize;
    const assignee = alias(users, 'assignee');
    const codeNum = parseCodeNumber(q);

    // Shared SQL fragments: the tsquery (unaccented, simple) and the per-row match.
    const tsq = sql`websearch_to_tsquery('simple', f_unaccent(${q}))`;
    const unaccentedLike = sql`('%' || f_unaccent(lower(${q})) || '%')`;

    // A ticket matches if: code-number equals (when q looks like a code) OR subject
    // tsv matches OR any of its messages' body tsv matches OR requester/assignee
    // name/email contains the (unaccented) query.
    const codeMatch =
      codeNum !== null
        ? sql`(${tickets.ticketCode} = ${'#' + String(codeNum).padStart(5, '0')} OR ${tickets.ticketCode} ILIKE ${'#%' + String(codeNum)})`
        : sql`false`;
    const subjectMatch = sql`(tickets.search_tsv @@ ${tsq})`;
    const bodyMatch = sql`EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = ${tickets.id} AND m.search_tsv @@ ${tsq})`;
    const requesterMatch = sql`(f_unaccent(lower(${tickets.requesterEmail})) LIKE ${unaccentedLike})`;
    const assigneeMatch = sql`(${assignee.name} IS NOT NULL AND f_unaccent(lower(${assignee.name})) LIKE ${unaccentedLike})`;

    const where = sql`(${codeMatch} OR ${subjectMatch} OR ${bodyMatch} OR ${requesterMatch} OR ${assigneeMatch})`;

    // Match label + ordering rank. Code hits first (rank 0), then ts_rank of the
    // subject tsv (body contributes via the OR but subject rank is the primary
    // signal), newest as the final tiebreak.
    const matchType = sql<SearchMatchType>`(CASE
      WHEN ${codeMatch} THEN 'code'
      WHEN ${subjectMatch} THEN 'subject'
      WHEN ${bodyMatch} THEN 'body'
      WHEN ${requesterMatch} THEN 'requester'
      ELSE 'assignee' END)`;
    const codeFirst = sql`(CASE WHEN ${codeMatch} THEN 0 ELSE 1 END)`;
    const rank = sql`ts_rank(tickets.search_tsv, ${tsq})`;
    // NOTE: headline runs over f_unaccent(subject) so the unaccented tsquery actually
    // highlights (accent-insensitive match, IT-SEARCH-001). Trade-off: the snippet text
    // is diacritic-stripped ("nghi phep"). A diacritic-preserving highlight needs
    // unaccent→original position mapping — deferred (see phaseC-code-review.md, #6).
    const headline = sql<string>`ts_headline('simple', f_unaccent(${tickets.subject}), ${tsq}, 'StartSel=<b>,StopSel=</b>,MaxFragments=1')`;

    return withActor(actor, async (tx) => {
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
          createdAt: tickets.createdAt,
          matchType,
          headline,
        })
        .from(tickets)
        .innerJoin(projects, sql`${projects.id} = ${tickets.projectId}`)
        .leftJoin(categories, sql`${categories.id} = ${tickets.categoryId}`)
        .leftJoin(assignee, sql`${assignee.id} = ${tickets.assigneeId}`)
        .where(where)
        .orderBy(codeFirst, sql`${rank} DESC`, sql`${tickets.createdAt} DESC`, sql`${tickets.id} ASC`)
        .limit(pageSize)
        .offset(offset);

      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(tickets)
        .leftJoin(assignee, sql`${assignee.id} = ${tickets.assigneeId}`)
        .where(where);
      const total = countRows[0]?.count ?? 0;

      const items: SearchResultItem[] = rows.map((r) => ({
        id: r.id,
        ticketCode: r.ticketCode,
        projectKey: r.projectKey,
        subject: r.subject,
        requesterEmail: r.requesterEmail,
        status: r.status,
        category: r.categoryVi ? { vi: r.categoryVi, en: r.categoryEn! } : null,
        assignee: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName! } : null,
        createdAt: r.createdAt,
        matchType: r.matchType,
        headline: r.headline ?? null,
      }));

      return { items, total, page, pageSize };
    });
  }
}
