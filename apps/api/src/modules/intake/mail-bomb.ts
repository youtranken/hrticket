import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { mailBombCounters, projectSettings, users } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { emitNotification } from '../notifications/emit';
import { enqueue, generateMessageId } from '../../infra/queue/outbox.service';

/** Fallback when a project has no project_settings row yet (mirrors the column default). */
const DEFAULT_MAIL_BOMB_PER_HOUR = 20;

export interface MailBombResult {
  /** True when this mail pushed the sender OVER the threshold → suppress it. */
  suppressed: boolean;
}

/**
 * Mail-bomb stage of the ingest pipeline (FR101, Story 7.2) — third hook, after
 * blocklist, before junk/intake. Counts NEW-ticket mail per (project, sender) in a
 * sliding 1-hour window; once the count exceeds the per-project threshold, the mail
 * is suppressed (caller flips inbox_messages.status='suppressed' + stops) — kept and
 * releasable, never dropped (NFR8). The FIRST mail to cross the threshold in a window
 * fires exactly one grouped Admin alert (in-app + email), deduped via mail_bomb_alert_log.
 *
 * Called ONLY for new-ticket mail (no thread match), so an existing participant's reply
 * is never counted or suppressed (party-mode M6, mirrors the blocklist exception).
 */
export async function checkMailBomb(
  tx: DbTx,
  input: { projectId: number; sender: string; mailbox: string },
): Promise<MailBombResult> {
  const { projectId, sender, mailbox } = input;

  const [settings] = await tx
    .select({ perHour: projectSettings.mailBombPerHour })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId));
  const threshold = settings?.perHour ?? DEFAULT_MAIL_BOMB_PER_HOUR;

  // Sliding window = the current clock hour, computed from DB now() (not a JS Date) so
  // it agrees with the test Postgres clock. Atomic upsert+increment: the unique
  // (project, sender, window) is the mutex, RETURNING gives the post-increment count.
  const [counter] = (await tx.execute(sql`
    INSERT INTO mail_bomb_counters (project_id, sender, window_start, count)
    VALUES (${projectId}, ${sender}, date_trunc('hour', now()), 1)
    ON CONFLICT (project_id, sender, window_start)
    DO UPDATE SET count = mail_bomb_counters.count + 1
    RETURNING count, window_start
  `)) as unknown as Array<{ count: number; window_start: string }>;
  const count = Number(counter!.count);

  // At or below threshold → let it through to create a ticket.
  if (count <= threshold) return { suppressed: false };

  // Over threshold → suppress. The FIRST mail that crosses (count === threshold + 1)
  // claims the alert row and fires the grouped alert; later mails in the window find
  // the row already there and stay silent (dedup).
  await maybeAlert(tx, {
    projectId,
    sender,
    mailbox,
    windowStart: counter!.window_start,
    threshold,
  });

  return { suppressed: true };
}

/** Fire exactly one grouped Admin alert per (project, sender, window). The alert_log
 *  UNIQUE + INSERT … ON CONFLICT DO NOTHING is the dedup: a non-empty RETURNING means
 *  we are the first crosser this window and own the alert. */
async function maybeAlert(
  tx: DbTx,
  input: { projectId: number; sender: string; mailbox: string; windowStart: string; threshold: number },
): Promise<void> {
  const claimed = (await tx.execute(sql`
    INSERT INTO mail_bomb_alert_log (project_id, sender, window_start)
    VALUES (${input.projectId}, ${input.sender}, ${input.windowStart})
    ON CONFLICT (project_id, sender, window_start) DO NOTHING
    RETURNING id
  `)) as unknown as Array<{ id: number }>;
  if (claimed.length === 0) return; // already alerted this window

  const held = await currentHeldCount(tx, input.projectId, input.sender, input.windowStart);

  const admins = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.projectId, input.projectId),
        inArray(users.role, ['admin', 'ssa']),
        eq(users.disabled, false),
      ),
    );

  for (const a of admins) {
    await emitNotification(tx, {
      actorId: a.id,
      type: 'mail_bomb',
      payload: { sender: input.sender, threshold: input.threshold, held },
    });
  }

  // One grouped email to the project admins (NFR8 visibility). Internal alert → goes
  // through the outbox like other business mail, autoSubmitted so no responder loops.
  // No idempotencyKey: alert_log already deduped us; a string key would break the UUID
  // column (Epic-6 pitfall) — let enqueue default a random UUID.
  const adminEmails = admins.map((a) => a.email);
  if (adminEmails.length > 0) {
    await enqueue(tx, {
      projectId: input.projectId,
      to: adminEmails,
      subject: `[Cảnh báo] Người gửi ${input.sender} vượt ngưỡng ${input.threshold} mail/giờ`,
      bodyText:
        `Người gửi ${input.sender} đã vượt ngưỡng ${input.threshold} mail/giờ. ` +
        `Hiện có ${held} mail đang được giữ lại (suppressed) và chờ bạn xem xét trong "Mail bị giữ".`,
      bodyHtml:
        `<p>Người gửi <b>${escapeHtml(input.sender)}</b> đã vượt ngưỡng ${input.threshold} mail/giờ.</p>` +
        `<p>Hiện có <b>${held}</b> mail đang được giữ lại (suppressed) và chờ bạn xem xét trong "Mail bị giữ".</p>`,
      messageId: generateMessageId(input.mailbox),
      headers: { autoSubmitted: true },
    });
  }

  await writeAudit(tx, {
    projectId: input.projectId,
    actorLabel: 'system:intake',
    action: 'mail_bomb.alert',
    objectType: 'sender',
    objectId: input.sender,
    newValue: { threshold: input.threshold, held, windowStart: input.windowStart },
  });
}

/** How many mails from this sender in this window are over the line so far (count
 *  beyond the threshold = number currently held). Read at alert time for the message. */
async function currentHeldCount(
  tx: DbTx,
  projectId: number,
  sender: string,
  windowStart: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: mailBombCounters.count })
    .from(mailBombCounters)
    .where(
      and(
        eq(mailBombCounters.projectId, projectId),
        eq(mailBombCounters.sender, sender),
        eq(mailBombCounters.windowStart, sql`${windowStart}`),
      ),
    );
  return row ? Math.max(0, Number(row.count)) : 0;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
