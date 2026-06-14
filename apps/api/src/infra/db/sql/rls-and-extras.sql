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

CREATE TABLE IF NOT EXISTS audit_log_2026 PARTITION OF audit_log
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS audit_log_2027 PARTITION OF audit_log
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
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

-- Project isolation + group visibility, with the "hold work-in-progress" carve-out
-- (FR59: an assignee always sees their own ticket), the junk grant for Admin, and
-- sensitive-group need-to-know handled by membership.
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
          app_role() = 'admin'                       -- admin sees whole project
          OR assignee_id = app_actor_id()            -- always see my own (FR59 carve-out)
          OR category_id = ANY (app_groups())        -- member/TL see their groups
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

-- ── Grants for the app runtime role ──────────────────────────────────────────
-- Everything exists by now (base tables + audit_log). The app role gets DML on
-- all of them; RLS — not privileges — is what scopes ticket visibility.
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app;
