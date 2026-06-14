import type { DbTx } from '../../infra/db/with-actor';
import { notifications } from '../../infra/db/schema';

export interface NotificationInput {
  /** The user who should SEE this notification (notifications.actor_id). */
  actorId: string;
  type: string;
  payload?: object;
}

/**
 * The ONE write path for in-app notifications (Story 6.1). Every emit point — auto
 * assign (4.2), manual assign / claim-over (4.4/4.5), reopen / resume (5.3/5.5),
 * snooze-due (6.3), and the worker/intake alerts — funnels through here so the row
 * shape and payload encoding live in one place. Always called inside the caller's tx
 * (atomic with the business change). RLS (notifications_*) scopes who can READ them.
 */
export async function emitNotification(tx: DbTx, input: NotificationInput): Promise<void> {
  await tx.insert(notifications).values({
    actorId: input.actorId,
    type: input.type,
    payload: input.payload ? JSON.stringify(input.payload) : null,
  });
}
