import { sql } from 'drizzle-orm';
import type { DbTx } from '../db/with-actor';

export interface AuditEntry {
  projectId?: number | null;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  objectType?: string | null;
  objectId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Append a row to the partitioned audit_log, IN the caller's transaction
 * (architecture invariant #8). audit_log lives in custom SQL (not the Drizzle
 * schema), so we insert via raw SQL. Append-only — never updated or deleted.
 */
export async function writeAudit(tx: DbTx, e: AuditEntry): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_log
      (project_id, actor_id, actor_label, action, object_type, object_id, old_value, new_value)
    VALUES (
      ${e.projectId ?? null},
      ${e.actorId ?? null},
      ${e.actorLabel ?? null},
      ${e.action},
      ${e.objectType ?? null},
      ${e.objectId ?? null},
      ${e.oldValue === undefined ? null : JSON.stringify(e.oldValue)}::jsonb,
      ${e.newValue === undefined ? null : JSON.stringify(e.newValue)}::jsonb
    )
  `);
}
