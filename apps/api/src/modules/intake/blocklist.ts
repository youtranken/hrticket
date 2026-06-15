import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { blocklist } from '../../infra/db/schema';

/**
 * Blocklist stage of the ingest pipeline (FR100, Story 7.1) — second hook, after
 * dedupe, before mail-bomb. Returns true when `fromEmail` is on the project's
 * blocklist, so the orchestrator can flip the inbox row to `blocked` and stop:
 * NO ticket, NO auto-ack, but the row + an audit entry persist (NFR8 — never drop
 * silently).
 *
 * Exact-address match, case-insensitive, scoped to the receiving mailbox's project
 * (per-project, AC2). No wildcards at v1 — sender patterns like `noreply@*` are junk
 * rules (Story 7.3). Called ONLY for new-ticket mail (no thread match), so a reply
 * from someone who is already a participant on an open/closed thread is never cut
 * (AC3) — that path goes through findThread/append, which doesn't reach here.
 */
export async function isBlocked(
  tx: DbTx,
  projectId: number,
  fromEmail: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: blocklist.id })
    .from(blocklist)
    .where(
      and(
        eq(blocklist.projectId, projectId),
        sql`lower(${blocklist.email}) = lower(${fromEmail})`,
      ),
    )
    .limit(1);
  return !!row;
}
