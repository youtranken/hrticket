import { and, eq, gt, or, sql } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { users, notifications } from '../../infra/db/schema';
import { emitNotification } from '../notifications/emit';

export const MAILBOX_ALERT_TYPE = 'mailbox_down';
const DEDUP_MS = 3_600_000; // one alert per project per hour (the poll loop runs every 60s)

export interface MailboxAlertInput {
  projectId: number;
  projectKey: string;
  projectName: string;
  error: string;
}

/**
 * Alert a project's OWN admins (+ every global SSA) that ITS mailbox poll is failing
 * — wrong App Password, connection refused, etc. Unlike the worker-liveness monitor
 * (whole-loop failures = system-wide), this is scoped to the affected project so the
 * HRIS admin never sees a CNB mailbox problem and vice-versa. Deduped to one alert per
 * project per hour so the 60s poll loop doesn't spam the bell. Returns rows inserted.
 */
export async function alertMailboxDown(input: MailboxAlertInput, now = Date.now()): Promise<number> {
  const since = new Date(now - DEDUP_MS);
  return withActor(systemActor, async (tx) => {
    // Already alerted for THIS project within the hour? (payload is a JSON string.)
    const recent = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, MAILBOX_ALERT_TYPE),
          gt(notifications.createdAt, since),
          sql`(${notifications.payload}::jsonb ->> 'projectId') = ${String(input.projectId)}`,
        ),
      )
      .limit(1);
    if (recent.length > 0) return 0;

    // Recipients: admins OF THIS PROJECT + all SSA (SSA is global by role, not by project).
    const recipients = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.disabled, false),
          or(and(eq(users.role, 'admin'), eq(users.projectId, input.projectId)), eq(users.role, 'ssa')),
        ),
      );

    for (const r of recipients) {
      await emitNotification(tx, {
        actorId: r.id,
        type: MAILBOX_ALERT_TYPE,
        payload: {
          projectId: input.projectId,
          projectKey: input.projectKey,
          projectName: input.projectName,
          error: input.error.slice(0, 200), // keep the row small; never leaks the password (IMAP errors don't carry it)
        },
      });
    }
    return recipients.length;
  });
}
