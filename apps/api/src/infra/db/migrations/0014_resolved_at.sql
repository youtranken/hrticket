-- Report v2 (đơn 13 redesign): resolution timestamp for "avg handling time" and
-- "% on-time". Stamped by the trg_tickets_resolved_at trigger (rls-and-extras.sql)
-- whenever a ticket ENTERS resolved/closed; cleared on reopen so a re-resolution
-- restamps. Backfill: closed tickets use closed_at (exact); tickets currently
-- sitting in `resolved` have no recorded instant — left NULL, excluded from avgs.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
--> statement-breakpoint
UPDATE tickets SET resolved_at = closed_at WHERE resolved_at IS NULL AND closed_at IS NOT NULL;
