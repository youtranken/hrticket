import { Injectable } from '@nestjs/common';
import { sql as raw } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';

export interface ReadinessReport {
  ok: boolean;
  db: 'up' | 'down';
  outboxPending: number | null;
  workerStale: boolean; // true only if heartbeats exist AND are stale
}

/** Worker heartbeat is considered stale after this many seconds. */
const HEARTBEAT_STALE_SECONDS = 180;

@Injectable()
export class DbHealthService {
  async check(): Promise<ReadinessReport> {
    try {
      return await withActor(systemActor, async (tx) => {
        await tx.execute(raw`SELECT 1`);

        const pending = await tx.execute(
          raw`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending'`,
        );
        const outboxPending = (pending[0] as { n: number }).n;

        // Empty heartbeats table = OK (worker not deployed yet) — party-mode A8.
        const stale = await tx.execute(
          raw`SELECT count(*)::int AS n FROM worker_heartbeats
              WHERE last_beat_at < now() - (${HEARTBEAT_STALE_SECONDS} || ' seconds')::interval`,
        );
        const workerStale = (stale[0] as { n: number }).n > 0;

        return { ok: true, db: 'up' as const, outboxPending, workerStale };
      });
    } catch {
      return { ok: false, db: 'down', outboxPending: null, workerStale: false };
    }
  }
}
