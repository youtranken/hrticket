import { sql } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { workerHeartbeats } from '../../infra/db/schema';

/** Upsert a loop's heartbeat (worker_heartbeats). /readyz reads staleness from here. */
export async function beat(loopName: string, status: 'ok' | 'error' = 'ok'): Promise<void> {
  await withActor(systemActor, (tx) =>
    tx
      .insert(workerHeartbeats)
      .values({ loopName, status })
      .onConflictDoUpdate({
        target: workerHeartbeats.loopName,
        set: { lastBeatAt: sql`now()`, status },
      }),
  );
}
