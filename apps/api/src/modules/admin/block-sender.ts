import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { blocklist } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';

export interface AddToBlocklistInput {
  projectId: number;
  email: string;
  reason?: string | null;
  /** The user who blocked the sender (null when added by the system actor). */
  createdBy?: string | null;
  /** Label for the audit trail (user email, or a system label). */
  actorLabel: string;
}

export interface AddToBlocklistResult {
  id: number;
  /** False when the address was already blocked (idempotent add). */
  created: boolean;
}

/**
 * Add a sender to a project's blocklist (Story 7.1, FR100), in the caller's tx, with
 * an audit row. The single entry point so the "Chặn người gửi" buttons in the
 * mail-bomb (7.2) and manual-spam (7.4) flows all route here instead of duplicating
 * the insert + audit. Idempotent: re-blocking an existing address is a no-op that
 * still returns the row (created=false), so the caller never errors on a double-block.
 */
export async function addToBlocklist(
  tx: DbTx,
  input: AddToBlocklistInput,
): Promise<AddToBlocklistResult> {
  const email = input.email.trim();
  const [inserted] = await tx
    .insert(blocklist)
    .values({
      projectId: input.projectId,
      email,
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing({ target: [blocklist.projectId, blocklist.email] })
    .returning({ id: blocklist.id });

  if (inserted) {
    await writeAudit(tx, {
      projectId: input.projectId,
      actorId: input.createdBy ?? null,
      actorLabel: input.actorLabel,
      action: 'blocklist.added',
      objectType: 'blocklist',
      objectId: String(inserted.id),
      newValue: { email, reason: input.reason ?? null },
    });
    return { id: inserted.id, created: true };
  }

  // Already blocked — fetch the existing row id (case-insensitive, like the gate).
  const [existing] = await tx
    .select({ id: blocklist.id })
    .from(blocklist)
    .where(
      and(eq(blocklist.projectId, input.projectId), sql`lower(${blocklist.email}) = lower(${email})`),
    )
    .limit(1);
  return { id: existing!.id, created: false };
}
