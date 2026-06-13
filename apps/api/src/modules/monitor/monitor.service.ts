import { Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { workerHeartbeats, notifications, users } from '../../infra/db/schema';
import { Mailer } from '../../infra/mail/mailer';

const STALE_MS = Number(process.env.MONITOR_STALE_MS ?? 180_000); // 3× the 60s poll
const INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS ?? 30_000);
const ALERT_TYPE = 'worker_alert';

export interface MonitorResult {
  alerted: boolean;
  reason?: string;
  notified: number;
}

/**
 * Worker liveness monitor (NFR18). Runs IN THE API process — never the worker
 * watching itself. If any loop's heartbeat is stale or in error, it alerts every
 * Admin/SSA via an in-app notification AND a direct SMTP email (the worker's
 * outbox may itself be down), deduped to one alert per type per hour.
 */
@Injectable()
export class MonitorService {
  private readonly logger = new Logger(MonitorService.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly mailer: Mailer) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.checkOnce().catch((e) => this.logger.error(`monitor failed: ${(e as Error)?.message}`));
    }, INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One liveness pass. Returns what it found/did (used by tests). */
  async checkOnce(now = Date.now()): Promise<MonitorResult> {
    const unhealthy = await withActor(systemActor, async (tx) => {
      const beats = await tx.select().from(workerHeartbeats);
      return beats.filter(
        (b) => b.status.startsWith('error') || now - b.lastBeatAt.getTime() > STALE_MS,
      );
    });
    if (unhealthy.length === 0) return { alerted: false, notified: 0 };

    const reason = unhealthy.map((b) => `${b.loopName}=${b.status}`).join(', ');
    const notified = await this.raiseAlert(reason, now);
    return { alerted: notified > 0, reason, notified };
  }

  /** Insert in-app notifications + send one email, deduped to 1/hour. Returns rows made. */
  private async raiseAlert(reason: string, now: number): Promise<number> {
    const oneHourAgo = new Date(now - 3_600_000);
    const recipients = await withActor(systemActor, async (tx) => {
      const recent = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.type, ALERT_TYPE), gt(notifications.createdAt, oneHourAgo)))
        .limit(1);
      if (recent.length > 0) return []; // already alerted this hour (dedup)

      const admins = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(inArray(users.role, ['admin', 'ssa']), eq(users.disabled, false)));
      for (const a of admins) {
        await tx.insert(notifications).values({
          actorId: a.id,
          type: ALERT_TYPE,
          payload: JSON.stringify({ reason, at: new Date(now).toISOString() }),
        });
      }
      return admins;
    });

    if (recipients.length === 0) return 0;

    // Direct SMTP (not the outbox — it may be the thing that's down). Best-effort.
    try {
      await this.mailer.send({
        to: recipients.map((r) => r.email).join(','),
        subject: '[HRIS] Worker degraded',
        text: `A worker loop is unhealthy: ${reason}`,
      });
    } catch (e) {
      this.logger.error(`alert email failed: ${(e as Error)?.message}`);
    }
    this.logger.warn(`worker alert raised (${reason}) → ${recipients.length} recipient(s)`);
    return recipients.length;
  }
}
