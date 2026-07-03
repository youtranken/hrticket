-- Snapshot re-sync ONLY (3/7/2026). Columns below were added by the HAND-WRITTEN
-- migrations 0013_digest_split / 0014_resolved_at, which drizzle-kit cannot see —
-- this generated file exists purely so meta/0015_snapshot.json matches the Drizzle
-- schema again (otherwise every future `db:generate` re-emits these ALTERs, the
-- known pitfall in CLAUDE.md). IF NOT EXISTS makes it a no-op everywhere: existing
-- DBs already have the columns; fresh DBs get them from 0013/0014 one step earlier.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminder_config" ADD COLUMN IF NOT EXISTS "digest_minute" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_config" ADD COLUMN IF NOT EXISTS "pool_unclaimed_days" integer DEFAULT 2 NOT NULL;
