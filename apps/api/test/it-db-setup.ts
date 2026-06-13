import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Spins up a throwaway Postgres 18 container for integration tests, then applies
 * migrations + custom SQL via the same runMigrations() the app uses. The full
 * shared harness (factories, GreenMail) lands in Story 1.3; this is the DB slice
 * needed by IT-DB-001..004. Requires a running Docker daemon.
 */
export async function startTestDb(): Promise<{
  container: StartedPostgreSqlContainer;
  url: string;
}> {
  const container = await new PostgreSqlContainer('postgres:18.4')
    .withDatabase('hris')
    .withUsername('hris')
    .withPassword('hris')
    .start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;
  // Import AFTER DATABASE_URL is set so db.ts picks it up.
  const { runMigrations } = await import('../src/infra/db/migrate');
  await runMigrations();
  return { container, url };
}
