import { sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';

/**
 * Next per-project ticket code, e.g. `#00007` (FR14). The atomic
 * `UPDATE … SET last_no = last_no + 1 RETURNING` takes a row lock for the
 * duration, so concurrent intakes serialize → no gaps, no duplicates (AC2).
 * Each project counts independently.
 */
export async function nextTicketCode(tx: DbTx, projectId: number): Promise<string> {
  const rows = (await tx.execute(sql`
    UPDATE project_counters SET last_no = last_no + 1
    WHERE project_id = ${projectId}
    RETURNING last_no
  `)) as unknown as Array<{ last_no: number }>;
  const n = rows[0]!.last_no;
  return `#${String(n).padStart(5, '0')}`;
}
