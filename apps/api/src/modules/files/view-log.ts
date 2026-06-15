import { and, eq, gt, sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { viewLog } from '../../infra/db/schema';

/**
 * View-log writes for SENSITIVE categories (Story 8.3 — FR67/FR78/NFR5). Every
 * download of, and every read of, a sensitive ticket leaves an "who, when" trace
 * so a leak can be traced back (Epic 9 builds the reader UI).
 *
 * Dedup: a media player asks for many Range chunks per play, and a user may reopen
 * a ticket repeatedly — so we collapse repeats of the SAME (actor, target, action)
 * inside a 5-minute window to ONE row. "Claim-before-insert": we look for a recent
 * row first and skip if present (the time-window has no unique constraint to lean
 * on, so this is a read-then-write inside the caller's tx — acceptable: a duplicate
 * under a rare race is a harmless extra log line, never a missed one).
 *
 * Both writers run INSIDE the caller's withActor tx so the log shares the request's
 * RLS actor and commits atomically with the work it records.
 */
const DEDUP_WINDOW = sql`now() - interval '5 minutes'`;

/** Log a download (access-url mint) of a sensitive attachment. Deduped per
 *  (actor, attachment, 'file_download') within 5 minutes. */
export async function writeFileViewLog(
  tx: DbTx,
  e: { actorId: string; ticketId: string; attachmentId: string },
): Promise<void> {
  const [recent] = await tx
    .select({ id: viewLog.id })
    .from(viewLog)
    .where(
      and(
        eq(viewLog.actorId, e.actorId),
        eq(viewLog.attachmentId, e.attachmentId),
        eq(viewLog.action, 'file_download'),
        gt(viewLog.createdAt, DEDUP_WINDOW),
      ),
    )
    .limit(1);
  if (recent) return;

  await tx.insert(viewLog).values({
    actorId: e.actorId,
    ticketId: e.ticketId,
    attachmentId: e.attachmentId,
    action: 'file_download',
  });
}

/** Log a read of a sensitive ticket's detail. Deduped per (actor, ticket,
 *  'ticket_view') within 5 minutes (opening the same ticket twice in a minute = 1). */
export async function writeTicketViewLog(
  tx: DbTx,
  e: { actorId: string; ticketId: string },
): Promise<void> {
  const [recent] = await tx
    .select({ id: viewLog.id })
    .from(viewLog)
    .where(
      and(
        eq(viewLog.actorId, e.actorId),
        eq(viewLog.ticketId, e.ticketId),
        eq(viewLog.action, 'ticket_view'),
        gt(viewLog.createdAt, DEDUP_WINDOW),
      ),
    )
    .limit(1);
  if (recent) return;

  await tx.insert(viewLog).values({
    actorId: e.actorId,
    ticketId: e.ticketId,
    attachmentId: null,
    action: 'ticket_view',
  });
}
