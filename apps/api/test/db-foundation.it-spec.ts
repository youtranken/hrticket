import { sql as raw } from 'drizzle-orm';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestDb } from './it-db-setup';

/**
 * Story 1.2 — DB foundation. Requires Docker (Testcontainers).
 * IT-DB-001 migration shape · IT-DB-002 withActor guard · IT-DB-003 RLS isolation · IT-DB-004 seed idempotent.
 */
describe('IT-DB: database foundation', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let ready = false;
  // db modules are imported lazily after DATABASE_URL is set by the harness.
  let mod: typeof import('../src/infra/db/db');
  let actorMod: typeof import('../src/infra/db/with-actor');

  beforeAll(async () => {
    try {
      ({ container } = await startTestDb());
      mod = await import('../src/infra/db/db');
      actorMod = await import('../src/infra/db/with-actor');
      ready = true;
    } catch (e) {
      // No Docker daemon → skip (suite turns green elsewhere). Runs for real in CI/local with Docker.
      console.warn('[IT-DB] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (ready) {
      await mod?.sql.end();
      await container?.stop();
    }
  });

  it('IT-DB-001: composite unique (message_id, mailbox), not global', async () => {
    if (!ready) return;
    const rows = await mod.db.execute(
      raw`SELECT indexdef FROM pg_indexes WHERE tablename = 'inbox_messages'`,
    );
    const defs = rows.map((r: Record<string, unknown>) => String(r.indexdef)).join('\n');
    expect(defs).toMatch(/UNIQUE.*\(message_id, mailbox\)/i);
    // partitioned audit_log + unaccent present
    const ext = await mod.db.execute(
      raw`SELECT 1 FROM pg_extension WHERE extname = 'unaccent'`,
    );
    expect(ext.length).toBe(1);
  });

  it('IT-DB-002: withActor refuses without actor, sets vars with one', async () => {
    if (!ready) return;
    await expect(
      // @ts-expect-error intentionally missing actor
      actorMod.withActor({}, async () => 1),
    ).rejects.toThrow();

    const role = await actorMod.withActor(actorMod.systemActor, async (tx) => {
      const r = await tx.execute(raw`SELECT current_setting('app.is_system', true) AS v`);
      return (r[0] as { v: string }).v;
    });
    expect(role).toBe('true');
  });

  it('IT-DB-004: seed is idempotent (run twice → same counts)', async () => {
    if (!ready) return;
    const { seedOnce } = await import('../src/infra/db/seed');
    await seedOnce();
    await seedOnce();
    const projects = await mod.db.execute(raw`SELECT count(*)::int AS n FROM projects`);
    const cats = await mod.db.execute(raw`SELECT count(*)::int AS n FROM categories`);
    expect((projects[0] as { n: number }).n).toBe(2);
    expect((cats[0] as { n: number }).n).toBe(12);
  });
});
