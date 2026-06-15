import { Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { projectSettings, users, notifications } from '../../infra/db/schema';
import * as storage from '../../infra/storage/fs-storage';
import type { DiskUsage } from '../../infra/storage/fs-storage';
import { emitNotification } from '../notifications/emit';
import { Mailer } from '../../infra/mail/mailer';

const ALERT_TYPE = 'disk_low';

export interface DiskCheckResult {
  usedPct: number;
  freePct: number;
  /** project ids that breached their threshold this pass */
  breached: number[];
  /** project ids actually alerted (after per-day dedup) */
  alerted: number[];
}

const VN_OFFSET_MS = 7 * 3_600_000; // Asia/Ho_Chi_Minh is UTC+7, no DST.

/** VN-local midnight today as a UTC instant — the dedup boundary (one alert/day,
 *  Asia/Ho_Chi_Minh per the reporting/scheduler convention). `now` injectable for tests.
 *  Shift into VN time, floor to the day, then shift back to UTC. */
function vnMidnightUtc(now: Date): Date {
  const vnMs = now.getTime() + VN_OFFSET_MS;
  const flooredVn = Math.floor(vnMs / 86_400_000) * 86_400_000;
  return new Date(flooredVn - VN_OFFSET_MS);
}

/**
 * Disk-space monitor (Story 8.4, FR76/NFR18). Runs in the WORKER scheduler — the
 * single background runner — so the periodic alert fires once, not once per api
 * replica. The storage root is one filesystem, so a single statfs covers all
 * projects; each project's `disk_alert_pct` threshold is applied independently
 * (NFR6). When free space drops below a project's threshold, its Admins/SSAs get an
 * in-app notification + a direct SMTP email (not the outbox — the disk being full
 * could be why outbound is stuck), deduped to one alert per project per VN-day.
 */
@Injectable()
export class DiskMonitorService {
  private readonly logger = new Logger(DiskMonitorService.name);

  constructor(private readonly mailer: Mailer) {}

  async checkDiskOnce(now: Date = new Date()): Promise<DiskCheckResult> {
    const usage = await storage.diskUsage();
    const breached: number[] = [];
    const alerted: number[] = [];
    const since = vnMidnightUtc(now);

    await withActor(systemActor, async (tx) => {
      const settings = await tx
        .select({ projectId: projectSettings.projectId, threshold: projectSettings.diskAlertPct })
        .from(projectSettings);

      for (const s of settings) {
        if (usage.freePct >= s.threshold) continue;
        breached.push(s.projectId);

        const recipients = await this.projectAdmins(tx, s.projectId);
        if (recipients.length === 0) continue;

        // Dedup per (project, VN-day), NOT per recipient: an SSA spans both projects,
        // so a recipient-keyed dedup would let project A's alert suppress project B's.
        // Key on the payload's projectId instead.
        const recent = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.type, ALERT_TYPE),
              gte(notifications.createdAt, since),
              sql`(${notifications.payload}::jsonb ->> 'projectId') = ${String(s.projectId)}`,
            ),
          )
          .limit(1);
        if (recent.length > 0) continue; // already alerted for this project today

        for (const r of recipients) {
          await emitNotification(tx, {
            actorId: r.id,
            type: ALERT_TYPE,
            payload: {
              projectId: s.projectId,
              freePct: usage.freePct,
              threshold: s.threshold,
              at: now.toISOString(),
            },
          });
        }
        alerted.push(s.projectId);
        await this.email(recipients.map((r) => r.email), s.projectId, usage, s.threshold);
      }
    });

    if (alerted.length > 0) {
      this.logger.warn(`disk low (free ${usage.freePct}%) → alerted projects ${alerted.join(', ')}`);
    }
    return { usedPct: usage.usedPct, freePct: usage.freePct, breached, alerted };
  }

  /** Active Admins/SSAs who should hear about THIS project: project-scoped admins of
   *  the project, plus all SSAs (an SSA spans both projects). */
  private async projectAdmins(
    tx: Parameters<Parameters<typeof withActor>[1]>[0],
    projectId: number,
  ): Promise<{ id: string; email: string }[]> {
    const rows = await tx
      .select({ id: users.id, email: users.email, role: users.role, projectId: users.projectId })
      .from(users)
      .where(and(eq(users.disabled, false), inArray(users.role, ['admin', 'ssa'])));
    return rows
      .filter((u) => u.role === 'ssa' || u.projectId === projectId)
      .map((u) => ({ id: u.id, email: u.email }));
  }

  private async email(to: string[], projectId: number, usage: DiskUsage, threshold: number): Promise<void> {
    try {
      await this.mailer.send({
        to: to.join(','),
        subject: '[HRIS] Attachment storage low on disk',
        text:
          `Storage free space is ${usage.freePct}% (threshold ${threshold}%) for project ${projectId}.\n` +
          `Used ${Math.round(usage.usedBytes / 1024 / 1024)}MB of ${Math.round(usage.totalBytes / 1024 / 1024)}MB.`,
      });
    } catch (e) {
      this.logger.error(`disk alert email failed: ${(e as Error)?.message}`);
    }
  }
}
