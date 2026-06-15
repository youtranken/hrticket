import { sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';

export interface JunkMatch {
  /** The rule id that caught it (audit provenance, FR103 tail). */
  ruleId: number;
  kind: 'keyword' | 'sender';
  pattern: string;
}

/**
 * Junk-rules stage of the ingest pipeline (FR102, Story 7.3) — fourth hook, after
 * mail-bomb, before intake. Returns the FIRST matching rule (or null) for a project:
 *   - keyword: whole-word, accent-insensitive contains over Subject + Body (same
 *     `f_unaccent` + \m…\M word-boundary match as keyword classification, Story 4.1 —
 *     "ung tuyen" finds "ứng tuyển"). Short keywords are an admin concern.
 *   - sender: a glob over the From address (`noreply@*`, `*@marketing.x.com`). LIKE
 *     metacharacters in the pattern are escaped first; then the glob `*` becomes SQL
 *     `%`, so a literal `%`/`_` can't act as a wildcard. Case-insensitive.
 *
 * Called ONLY for new-ticket mail (no thread match) — same scope as blocklist/
 * mail-bomb (party-mode M6): a reply on an existing thread is never auto-junked.
 */
export async function matchJunkRule(
  tx: DbTx,
  projectId: number,
  input: { subject: string; body: string | null | undefined; from: string },
): Promise<JunkMatch | null> {
  const haystack = `${input.subject ?? ''}\n${input.body ?? ''}`;
  const from = input.from;

  // Regex metachars to backslash-escape for the keyword whole-word match (mirrors
  // classify.service so behaviour is identical).
  const META = '[.^$*+?()\\[\\]{}|\\\\-]';
  const REPL = '\\\\\\&';

  const rows = (await tx.execute(sql`
    SELECT r.id AS id, r.kind AS kind, r.pattern AS pattern
    FROM junk_rules r
    WHERE r.project_id = ${projectId}
      AND (
        (
          r.kind = 'keyword'
          AND f_unaccent(lower(${haystack})) ~ (
            '\\m' || regexp_replace(f_unaccent(lower(r.pattern)), ${META}, ${REPL}, 'g') || '\\M'
          )
        )
        OR (
          r.kind = 'sender'
          AND lower(${from}) LIKE lower(
            -- 1) escape LIKE metachars (\ % _) so they're literal, THEN 2) turn the
            --    glob '*' into the LIKE wildcard '%'.
            replace(
              replace(replace(replace(r.pattern, '\\', '\\\\'), '%', '\\%'), '_', '\\_'),
              '*', '%'
            )
          ) ESCAPE '\\'
        )
      )
    ORDER BY r.id ASC
    LIMIT 1
  `)) as unknown as Array<{ id: number; kind: 'keyword' | 'sender'; pattern: string }>;

  if (!rows[0]) return null;
  return { ruleId: Number(rows[0].id), kind: rows[0].kind, pattern: rows[0].pattern };
}
