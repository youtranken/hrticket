import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface ItHarness {
  container: StartedPostgreSqlContainer;
  db: typeof import('../src/infra/db/db')['db'];
  sql: typeof import('../src/infra/db/db')['sql'];
  stop: () => Promise<void>;
}

/**
 * Shared integration harness: throwaway Postgres 18 + migrations + custom SQL,
 * optionally seeded. The GreenMail mail container is added when the email engine
 * lands (Epic 2). Requires a running Docker daemon; callers self-skip when absent.
 */
export async function startHarness(opts: { seed?: boolean } = {}): Promise<ItHarness> {
  const container = await new PostgreSqlContainer('postgres:18.4')
    .withDatabase('hris')
    .withUsername('hris')
    .withPassword('hris')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();

  const { runMigrations } = await import('../src/infra/db/migrate');
  await runMigrations();
  if (opts.seed) {
    const { seedOnce } = await import('../src/infra/db/seed');
    await seedOnce();
  }

  const dbMod = await import('../src/infra/db/db');
  return {
    container,
    db: dbMod.db,
    sql: dbMod.sql,
    stop: async () => {
      await dbMod.sql.end();
      await container.stop();
    },
  };
}

/** Returns true if a Docker daemon is reachable; lets suites skip cleanly. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const c = await new PostgreSqlContainer('postgres:18.4').start();
    await c.stop();
    return true;
  } catch {
    return false;
  }
}
