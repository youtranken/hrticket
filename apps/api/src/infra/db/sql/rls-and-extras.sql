-- Custom DDL that Drizzle cannot express. Applied by migrate.ts AFTER the
-- generated migration. Idempotent (safe to re-run). Story 1.2b.

-- ── Extensions ───────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ── App runtime role ─────────────────────────────────────────────────────────
-- A superuser/owner connection BYPASSES RLS entirely. So the app must act as a
-- plain, non-superuser role for the policies to bite. withActor() does
-- `SET LOCAL ROLE app` per transaction; the privilege grants live at the end of
-- this file (after every table — including audit_log — exists).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app NOLOGIN;
  END IF;
END $$;

-- unaccent() ships as STABLE, so Postgres rejects it inside a GENERATED column
-- (which requires IMMUTABLE). Wrap the 2-arg form (explicit dictionary, so the
-- result truly can't drift) and mark the wrapper IMMUTABLE — the documented
-- workaround. Used by the FTS generated column below.
CREATE OR REPLACE FUNCTION f_unaccent(text)
  RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

-- ── Full-text search (FR81, party-mode A7): simple + unaccent over subject+body ──
ALTER TABLE ticket_messages
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      f_unaccent(coalesce(body_text, '')))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_messages_search ON ticket_messages USING gin (search_tsv);

-- Subject FTS (Story 10.2): the worklist search hits subject (tickets) + body
-- (ticket_messages). Same simple + f_unaccent recipe as the body tsv above, so
-- "nghỉ phép" ↔ "nghi phep" matches symmetrically. Not in the Drizzle snapshot
-- (like the body tsv) — drizzle diffs schema.ts, not the live DB, so it's left be.
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      f_unaccent(coalesce(subject, '')))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_tickets_search ON tickets USING gin (search_tsv);

-- ── Partitioned audit log (NFR12/FR69) — created here, not in Drizzle ────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial   NOT NULL,
  project_id  integer,
  actor_id    uuid,
  actor_label text,
  action      text        NOT NULL,
  object_type text,
  object_id   text,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Yearly RANGE partitions, AUTO-EXTENDED on every migrate from 2026 to now()+5 years,
-- so a future INSERT can never fail for a missing partition. A gap would abort EVERY
-- audited mutation in-tx and halt the system (audit is written in the SAME tx as the
-- mutation it records). A DEFAULT catch-all backstops any row beyond the explicit years
-- or a clock skew, so the system can never hard-halt on this again. Append-only
-- (REVOKE UPDATE/DELETE) is re-applied to ALL partitions in the grants section below.
DO $mkpart$
DECLARE y int;
BEGIN
  FOR y IN 2026 .. (EXTRACT(YEAR FROM now())::int + 5) LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS audit_log_%s PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      y, (y || '-01-01'), ((y + 1) || '-01-01'));
  END LOOP;
END $mkpart$;
CREATE TABLE IF NOT EXISTS audit_log_default PARTITION OF audit_log DEFAULT;
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_log (object_type, object_id);

-- Append-only (FR68): app role may INSERT/SELECT only, never UPDATE/DELETE.
-- (Role grants are environment-specific; enforced in deploy. Documented here.)

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Helper accessors over the transaction-scoped session vars set by withActor().
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT current_setting('app.is_system', true) = 'true' $$;
CREATE OR REPLACE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT current_setting('app.actor_role', true) $$;
CREATE OR REPLACE FUNCTION app_project_id() RETURNS integer LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.project_id', true), '')::integer $$;
CREATE OR REPLACE FUNCTION app_actor_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_groups() RETURNS integer[] LANGUAGE sql STABLE AS
  $$ SELECT CASE
       WHEN coalesce(current_setting('app.groups', true), '') = '' THEN '{}'::integer[]
       ELSE string_to_array(current_setting('app.groups', true), ',')::integer[]
     END $$;

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY; -- apply even to the table owner

-- System actor: full scope (NOT bypassrls — explicit grant).
DROP POLICY IF EXISTS tickets_system ON tickets;
CREATE POLICY tickets_system ON tickets
  USING (app_is_system())
  WITH CHECK (app_is_system());

-- Project isolation + group visibility, with the BOUNDED "hold work-in-progress"
-- carve-out (FR59) and the junk grant for Admin; sensitive-group need-to-know is
-- handled by membership.
--
-- Keep-work-in-progress (Story 9.3 AC1/AC2): an assignee ALWAYS sees a ticket assigned
-- to them while it is still OPEN work — even after they're removed from its group or it
-- is re-categorised out of their groups. The carve-out EXPIRES the moment the ticket is
-- closed (status = 'closed') or reassigned to someone else (assignee_id changes): a
-- closed ticket whose group the user no longer belongs to becomes invisible again.
-- (Without the `status <> 'closed'` bound, a removed-from-group ex-assignee would keep
-- seeing every ticket they ever closed — a need-to-know leak. FR59 only protects work
-- still in flight.)
DROP POLICY IF EXISTS tickets_user ON tickets;
CREATE POLICY tickets_user ON tickets
  USING (
    NOT app_is_system()
    AND (
      -- SSA sees both projects
      app_role() = 'ssa'
      OR (
        project_id = app_project_id()
        AND (
          app_role() = 'admin'                                       -- admin sees whole project
          OR (assignee_id = app_actor_id() AND status <> 'closed')   -- keep work-in-progress (FR59), bounded
          OR category_id = ANY (app_groups())                        -- member/TL see their groups
        )
      )
    )
  );

-- Drafts are strictly per-user (FR105) — RLS so one employee can never read
-- another's half-written reply, even via a crafted query (Story 3.5 / AC3).
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS drafts_system ON drafts;
CREATE POLICY drafts_system ON drafts
  USING (app_is_system())
  WITH CHECK (app_is_system());
DROP POLICY IF EXISTS drafts_owner ON drafts;
CREATE POLICY drafts_owner ON drafts
  USING (NOT app_is_system() AND user_id = app_actor_id())
  WITH CHECK (NOT app_is_system() AND user_id = app_actor_id());

-- Notifications are strictly per-recipient on READ (Story 6.1 AC4): a user can only
-- ever see / mark-read their OWN, even via a crafted query. INSERT stays open to any
-- authenticated user, because cross-user emits are normal (manual assign / claim-over
-- notify the OTHER person); the system actor has full scope for worker/intake emits.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_system ON notifications;
CREATE POLICY notifications_system ON notifications
  USING (app_is_system())
  WITH CHECK (app_is_system());
DROP POLICY IF EXISTS notifications_read ON notifications;
CREATE POLICY notifications_read ON notifications
  FOR SELECT USING (NOT app_is_system() AND actor_id = app_actor_id());
DROP POLICY IF EXISTS notifications_update ON notifications;
CREATE POLICY notifications_update ON notifications
  FOR UPDATE USING (NOT app_is_system() AND actor_id = app_actor_id())
  WITH CHECK (actor_id = app_actor_id());
DROP POLICY IF EXISTS notifications_insert ON notifications;
CREATE POLICY notifications_insert ON notifications
  FOR INSERT WITH CHECK (NOT app_is_system());

-- ── Grants for the app runtime role ──────────────────────────────────────────
-- Everything exists by now (base tables + audit_log). The app role gets DML on
-- all of them; RLS — not privileges — is what scopes ticket visibility.
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app;

-- ── Audit log is APPEND-ONLY (FR68/NFR12) ────────────────────────────────────
-- The blanket GRANT above handed the app role UPDATE/DELETE on every table; take
-- those back on audit_log so the running app can only INSERT + SELECT. Even a
-- compromised app path (or a buggy query) cannot rewrite or erase history; there is
-- also no UPDATE/DELETE endpoint. Revoke on the parent AND every partition (each is a
-- real table with its own privileges from "ON ALL TABLES"). Story 9.5 verifies this.
REVOKE UPDATE, DELETE ON audit_log FROM app;
-- Every partition (the auto-created years above + the DEFAULT) — resolved dynamically
-- so a freshly auto-added partition is locked down on the SAME migrate that creates it.
DO $revpart$
DECLARE part regclass;
BEGIN
  FOR part IN SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'audit_log'::regclass LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM app', part);
  END LOOP;
END $revpart$;
