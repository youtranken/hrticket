import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { categories } from '../../infra/db/schema';

export type ClassifyReason = 'single_match' | 'multi_match' | 'no_match';

export interface ClassifyResult {
  categoryId: number;
  /** Keywords that decided it (audit). Empty when it fell back to "Khác". */
  matchedKeywords: string[];
  reason: ClassifyReason;
}

/** The seeded system "Khác"/Other bucket for a project (FR23 fallback). */
export async function otherCategoryId(tx: DbTx, projectId: number): Promise<number> {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.projectId, projectId), eq(categories.isSystem, true)));
  return row!.id;
}

/**
 * Keyword classification (FR21/FR23). Scan Subject + Body against every active,
 * non-system category's keywords, matching case- AND accent-insensitively via the
 * same `f_unaccent` used by FTS (so "nghi phep" finds "nghỉ phép"). The match is a
 * substring contains — short keywords are an admin concern (Story 4.6).
 *
 * Exactly one category matched → that category. Zero OR more-than-one → "Khác"
 * (ambiguous mail goes to the pool, never guessed). Pure tx fn: runs inside the
 * create-ticket transaction so the category is set atomically with the ticket.
 */
export async function classifyTicket(
  tx: DbTx,
  projectId: number,
  subject: string,
  body: string | null | undefined,
): Promise<ClassifyResult> {
  const haystack = `${subject ?? ''}\n${body ?? ''}`;

  const matched = (await tx.execute(sql`
    SELECT c.id AS category_id, k.keyword AS keyword
    FROM categories c
    JOIN category_keywords k ON k.category_id = c.id
    WHERE c.project_id = ${projectId}
      AND c.disabled = false
      AND c.is_system = false
      AND position(f_unaccent(lower(k.keyword)) IN f_unaccent(lower(${haystack}))) > 0
  `)) as unknown as Array<{ category_id: number; keyword: string }>;

  const distinct = new Set(matched.map((m) => Number(m.category_id)));

  if (distinct.size === 1) {
    const categoryId = Number(matched[0]!.category_id);
    return {
      categoryId,
      matchedKeywords: [...new Set(matched.map((m) => m.keyword))],
      reason: 'single_match',
    };
  }

  return {
    categoryId: await otherCategoryId(tx, projectId),
    matchedKeywords: [],
    reason: distinct.size > 1 ? 'multi_match' : 'no_match',
  };
}
