import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { db, sql } from './db';

/**
 * Applies generated Drizzle migrations, then the custom DDL (extensions, FTS,
 * partitioned audit_log, RLS) that Drizzle cannot express. Forward-only.
 * Run in CI + container entrypoint — NEVER from main.ts.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = join(__dirname, 'migrations');
  await migrate(db, { migrationsFolder });

  const extras = readFileSync(join(__dirname, 'sql', 'rls-and-extras.sql'), 'utf8');
  await db.execute(raw.raw(extras));
}

if (require.main === module) {
  runMigrations()
    .then(async () => {
      console.log('migrations applied');
      await sql.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('migration failed', err);
      await sql.end();
      process.exit(1);
    });
}
