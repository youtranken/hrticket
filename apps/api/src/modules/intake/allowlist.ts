import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { allowlist } from '../../infra/db/schema';

/**
 * Allowlist check — the inverse of the blocklist. When `fromEmail` is on the project's
 * allowlist, the intake treats the mail as a genuine human new-ticket mail EVEN IF it
 * carries list/bulk/auto-submitted headers (List-Id, List-Unsubscribe, Precedence:bulk,
 * Auto-Submitted, X-Autoreply…). This is the escape hatch for trusted senders whose
 * announcements go through a mailing list (e.g. hrdivision@pmh.com.vn via a Google Group)
 * but should still open a ticket.
 *
 * Scope-parity with the blocklist: exact-address, case-insensitive, per project. It only
 * relaxes the auto-submitted drop — the blocklist, mail-bomb and junk stages still apply.
 */
export async function isAllowlisted(
  tx: DbTx,
  projectId: number,
  fromEmail: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: allowlist.id })
    .from(allowlist)
    .where(
      and(
        eq(allowlist.projectId, projectId),
        sql`lower(${allowlist.email}) = lower(${fromEmail})`,
      ),
    )
    .limit(1);
  return !!row;
}
