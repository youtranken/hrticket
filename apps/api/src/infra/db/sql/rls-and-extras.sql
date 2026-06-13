-- Custom DDL that Drizzle cannot express. Applied by migrate.ts AFTER the
-- generated migration. Idempotent (safe to re-run). Story 1.2b.

-- ── Extensions ───────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ── Full-text search (FR81, party-mode A7): simple + unaccent over subject+body ──
ALTER TABLE ticket_messages
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      unaccent(coalesce(body_text, '')))
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
