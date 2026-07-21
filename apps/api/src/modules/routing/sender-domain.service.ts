import { sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';

export interface SenderDomainMatch {
  categoryId: number;
  /** The rule that decided it (audit provenance, FR104). */
  ruleId: number;
  pattern: string;
}

/**
 * Sender-domain routing (FR104, Story 4.7) — the SAFETY NET applied by the intake when
 * keyword classification did NOT produce a single match (would-be "Khác"). Matches the
 * From address against every `category_sender_rules` pattern for the project:
 *   - glob: `*@phth.com`, `*@*.phth.com` — same escaping as junk-rules `sender` (escape
 *     LIKE metachars `\ % _` so they're literal, THEN turn the glob `*` into `%`),
 *     case-insensitive.
 *   - exact: a pattern with NO `*` (e.g. `an@phth.com`) → the LIKE carries no wildcard →
 *     it matches that one address exactly. Same column, no separate kind.
 *
 * Conflict resolution — MOST-SPECIFIC WINS: an exact pattern beats a glob; a longer glob
 * (narrower, e.g. `*@vn.phth.com`) beats a shorter one (`*@*.com`); `id ASC` breaks the
 * final tie (deterministic). Rules whose target category is system ("Khác") or disabled
 * are ignored in SQL, so a stale rule never routes into a dead pool.
 */
export async function matchSenderDomain(
  tx: DbTx,
  projectId: number,
  from: string,
): Promise<SenderDomainMatch | null> {
  const rows = (await tx.execute(sql`
    SELECT r.id AS id, r.category_id AS category_id, r.pattern AS pattern
    FROM category_sender_rules r
    -- Tenant defense-in-depth: assert the rule's category is in the SAME project, so an
    -- out-of-band row (raw SQL / future import) with mismatched project_id can't route
    -- one project's mail into another project's category.
    JOIN categories c ON c.id = r.category_id AND c.project_id = r.project_id
    WHERE r.project_id = ${projectId}
      AND c.disabled = false
      AND c.is_system = false
      AND lower(${from}) LIKE lower(
        -- 1) escape LIKE metachars (\ % _) so they're literal, THEN 2) turn the glob
        --    '*' into the LIKE wildcard '%' (mirrors intake/junk-rules.ts sender match).
        replace(
          replace(replace(replace(r.pattern, '\\', '\\\\'), '%', '\\%'), '_', '\\_'),
          '*', '%'
        )
      ) ESCAPE '\\'
    ORDER BY (position('*' in r.pattern) > 0) ASC,  -- exact (no '*') before glob
             char_length(r.pattern) DESC,           -- narrower glob before wider
             r.id ASC
    LIMIT 1
  `)) as unknown as Array<{ id: number; category_id: number; pattern: string }>;

  if (!rows[0]) return null;
  return {
    categoryId: Number(rows[0].category_id),
    ruleId: Number(rows[0].id),
    pattern: rows[0].pattern,
  };
}
