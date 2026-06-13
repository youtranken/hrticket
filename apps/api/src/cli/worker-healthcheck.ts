import postgres from 'postgres';

/**
 * Docker healthcheck for the worker container (Story 2.7 / A.4). Exits non-zero
 * when the IMAP poll loop's heartbeat is stale → Docker restarts the container
 * (restart: always). An empty heartbeat table (just-booted) is treated as healthy
 * so a cold start isn't killed before the first beat.
 */
const STALE_MS = Number(process.env.WORKER_HEALTH_STALE_MS ?? 180_000);

const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });

sql`SELECT last_beat_at FROM worker_heartbeats WHERE loop_name = 'imap_poll'`
  .then(async (result) => {
    const rows = result as unknown as Array<{ last_beat_at: string | Date }>;
    let code = 0;
    if (rows.length > 0) {
      const age = Date.now() - new Date(rows[0]!.last_beat_at).getTime();
      if (age > STALE_MS) code = 1;
    }
    await sql.end();
    process.exit(code);
  })
  .catch(async () => {
    await sql.end().catch(() => undefined);
    process.exit(1);
  });
