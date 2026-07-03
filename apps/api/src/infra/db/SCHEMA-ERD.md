# Database Schema — Entity-Relationship Diagram (ASCII)

> Source of truth: `apps/api/src/infra/db/schema/*.ts` (Drizzle).
> One Postgres database (`hris`), two projects (`hris`, `cnb`) separated by a
> `project_id` column + RLS — NOT separate databases.
> `audit_log` is partitioned (BY RANGE created_at) and lives in raw SQL
> (`rls-and-extras.sql`), not in the Drizzle schema.

## Legend

```
[ table ]            an entity (PK in the first row)
 *col                 primary key
 #col                 foreign key
 ~col                 unique / natural key
──┤ ... ├──           relationship line
1───<                 one-to-many (the "<" / crow's-foot is the MANY side)
>───<                 many-to-many (resolved by a junction table)
1───1                 one-to-one
```

---

## 0. Bird's-eye: the 5 hubs everything hangs off

```
                         ┌──────────────┐
                         │  projects    │   2 rows: hris, cnb  (NFR6)
                         │  *id  ~key   │
                         └──────┬───────┘
        ┌───────────────┬───────┼────────────────┬──────────────────┐
        │ project_id    │       │ project_id     │ project_id       │ project_id
        ▼               ▼       ▼                ▼                  ▼
   ┌─────────┐   ┌────────────┐ │         ┌────────────┐    ┌─────────────────┐
   │  users  │   │ categories │ │         │   tags     │    │ email_templates │
   └────┬────┘   └─────┬──────┘ │         └─────┬──────┘    │ email_connections│
        │              │        │               │           │ reminder_config  │
        │              │        ▼               │           │ project_settings │
        │              │   ┌──────────┐         │           │ project_counters │
        │              └──>│ tickets  │<────────┘           │  blocklist ...   │
        │ assignee_id      │  *id     │  (category_id,      └─────────────────┘
        └─────────────────>│          │   assignee_id,         (per-project config,
                           └────┬─────┘   project_id)           1 row / project)
                                │
        the ticket is the 2nd hub: messages, attachments, participants,
        tags, drafts, links, logs all reference tickets.id
```

---

## 1. Core / identity / routing  (`schema/core.ts`)

```
┌─────────────────────────┐
│ projects                │
│ *id           bigserial │
│ ~key          enum hris|cnb
│  name                   │
└───────────┬─────────────┘
            │ 1
            │        project_id (nullable for global SSA)
            │  ┌──────────────────────────────────────────┐
            ├─<│ users                                     │
            │  │ *id            uuid                       │
            │  │ #project_id  → projects.id   (nullable)   │
            │  │ ~email         (uq_users_email)           │
            │  │  role          enum ssa|admin|team_lead|member
            │  │  disabled, otp_enabled, away_from/to, ... │
            │  └───────┬───────────────────────────────────┘
            │          │
            │          │ a user belongs to N categories  (FR58)
            │          │     >────────────┐
            │ 1        │ many             │ many
            │          ▼                  ▼
            │  ┌────────────────────────────────────┐      ┌───────────────────┐
            ├─<│ categories                         │1───<│ category_keywords  │
            │  │ *id          bigserial             │      │ *id                │
            │  │ #project_id → projects.id          │      │ #category_id → cat │
            │  │ ~(project_id,name_en)              │      │ ~(category_id,kw)  │
            │  │  name_vi, name_en, is_sensitive,   │      └───────────────────┘
            │  │  is_system, disabled               │
            │  └───┬───────────────┬────────┬───────┘
            │      │1              │1       │1
            │      ▼               ▼        ▼
            │  ┌───────────────┐ ┌───────────────────┐ ┌────────────────────┐
            │  │user_group_    │ │ auto_assign_config│ │ assign_cursors     │
            │  │membership     │ │ *id               │ │ *category_id → cat │
            │  │ *#user_id     │ │ ~#category_id→cat │ │ #last_user_id→users│
            │  │ *#category_id │ │  strategy enum    │ └────────────────────┘
            │  └───────────────┘ └────────┬──────────┘  (round-robin cursor, NFR9)
            │   (junction M:N)           │1
            │                            ▼
            │                  ┌──────────────────────┐
            │                  │ auto_assign_members  │
            │                  │ *#config_id → cfg    │
            │                  │ *#user_id   → users  │
            │                  │  position            │
            │                  └──────────────────────┘
            │                   (ordered round-robin list, FR25)
            │ 1
            ▼
   ┌────────────────────┐
   │ project_counters   │   race-free "#00001" per project (G1)
   │ *project_id → proj │
   │  last_no           │
   └────────────────────┘

┌─────────────────────────────┐
│ role_capabilities           │   runtime role→capability matrix (FR55).
│ *(role, capability)         │   NO FK — `role` is an enum value, not a row.
│  allowed  bool              │   SSA-editable; Guards read with 60s cache.
└─────────────────────────────┘
```

---

## 2. Tickets & conversation  (`schema/tickets.ts`)

```
┌──────────────────────────────────────────────┐
│ tickets                                       │
│ *id                uuid                       │
│ #project_id      → projects.id                │
│ #category_id     → categories.id   (nullable) │
│ #assignee_id     → users.id        (nullable, pool=NULL)
│ #junked_from_category_id → categories.id      │
│  ~(project_id, ticket_code)                   │
│  status enum open|assigned|in_progress|       │
│              pending|resolved|closed          │
│  assigned_at, snooze_until, reopen_count,     │
│  is_junk, is_spam_thread, last_opened_at ...  │
└──┬───────┬────────┬────────┬────────┬────────┬┘
   │1      │1       │1       │1       │1       │ (self, M:N)
   │       │        │        │        │        │
   ▼       ▼        ▼        ▼        ▼        ▼
┌────────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐
│ ticket_messages│ │ participants │ │ drafts   │ │ ticket_tags  │ │ ticket_link  │
│ *id  uuid      │ │ *id          │ │ *id      │ │ *#ticket_id  │ │ *id          │
│ #ticket_id     │ │ #ticket_id   │ │ #ticket_id│ │ *#tag_id ──┐ │ #ticket_a→tkt│
│  direction     │ │ ~(ticket,email)│ │ #user_id │ │            │ │ #ticket_b→tkt│
│  is_internal   │ │  status enum │ │  kind     │ │            │ │  kind        │
│  body_text/html│ │  active|...  │ │ ~(tkt,    │ │            │ └──────────────┘
│  message_id ...│ └──────────────┘ │  user,kind)│ │            │  cross-post pair
└───────┬────────┘                  └──────────┘  │            │  (FR17)
        │1                                         │ many       │ many
        │ message_id (nullable)                    ▼            │
        ▼                                   ┌──────────────┐    │
┌────────────────────┐                      │ tags         │<───┘
│ attachments        │  (schema/attachments)│ *id          │
│ *id  uuid          │                      │ #project_id  │
│ #ticket_id  → tkt  │                      │ ~(proj,name) │
│ #message_id → msg  │                      │  kind enum   │
│  file_name, size,  │                      └──────┬───────┘
│  mime_type,        │                             │1
│  storage_path,     │                             ▼
│  content_id,       │                      ┌──────────────────┐
│  status enum       │                      │ tag_keywords     │
│  pending|stored|.. │                      │ *id              │
└────────────────────┘                      │ #tag_id → tags   │
  file on disk by UUID:                      │ ~(tag_id,kw)     │
  {projectId}/{yyyy}/{mm}/{uuid}            └──────────────────┘
  (FR32 priority auto-tag)
```

---

## 3. Email pipeline  (`schema/email.ts`)

```
              INBOUND                                    OUTBOUND
   ┌────────────────────────────┐            ┌────────────────────────────┐
   │ inbox_messages             │            │ outbox                     │
   │ *id  uuid                  │            │ *id  uuid                  │
   │ #project_id → projects     │            │ #project_id → projects     │
   │ #ticket_id  → tickets (nbl)│            │ #ticket_id  → tickets (nbl)│
   │ ~(message_id, mailbox)     │            │ ~idempotency_key uuid      │
   │  raw, status enum          │            │  to/cc/bcc[], subject,body │
   │  received|processed|        │            │  status enum               │
   │  suppressed|blocked|failed │            │  pending|processing|done|  │
   │  attempts, next_attempt_at │            │  failed                    │
   └────────────────────────────┘            │  attempts, locked_at ...   │
     effectively-once dedup                  └────────────────────────────┘
     (composite key, NOT global)               at-least-once queue (NFR10)

   ┌──────────────────────┐   ┌────────────────────┐   ┌──────────────────────┐
   │ imap_cursor          │   │ blocklist          │   │ junk_rules           │
   │ *id                  │   │ *id                │   │ *id                  │
   │ ~mailbox             │   │ #project_id → proj │   │ #project_id → proj   │
   │  folder, last_uid    │   │ #created_by → users│   │  kind enum keyword|  │
   │  uidvalidity         │   │ ~(project,email)   │   │      sender, pattern │
   └──────────────────────┘   └────────────────────┘   └──────────────────────┘
     poll cursor (NFR8)         blocked senders (FR100)   auto-junk (FR102)

   ┌──────────────────────────┐   ┌──────────────────────────┐
   │ mail_bomb_counters       │   │ email_connections        │  1 row / project
   │ *id                      │   │ *project_id → projects   │  IMAP/SMTP host+port+
   │ #project_id → projects   │   │  imap_host/port/user     │  user, password_encrypted
   │ ~(project,sender,window) │   │  smtp_host/port/user     │  (AES-GCM). DB WINS env.
   │  count                   │   │  password_encrypted      │
   └──────────────────────────┘   │  status, last_checked_at │
     sliding window (FR101)       └──────────────────────────┘

   ┌──────────────────────────┐
   │ email_templates          │   bilingual auto_ack / digest / snooze_due /
   │ *id                      │   ticket_reopened / reopen_locked_notice (FR53/92)
   │ #project_id → projects   │
   │ ~(project_id, key)       │
   │  subject_vi/en, body_vi/en
   └──────────────────────────┘
```

---

## 4. Ops / audit / scheduler dedup  (`schema/ops.ts`)

```
   ┌──────────────────────┐        ┌──────────────────────────┐
   │ notifications        │        │ view_log                 │  sensitive-access trail
   │ *id  bigserial       │        │ *id                      │  (FR67)
   │ #actor_id → users    │        │ #actor_id     → users    │
   │  type, payload(JSON) │        │ #ticket_id    → tickets  │
   │  read_at, created_at │        │ #attachment_id→ attach.  │
   │  idx(actor_id,read_at)│       │  action enum ticket_view |
   └──────────────────────┘        │              file_download│
     in-app bell, delta-poll       └──────────────────────────┘
     (FR54). 304 watermark =
     max(created_at)

   Per-project config (1 row each, PK = project_id → projects.id):
   ┌──────────────────┐  ┌──────────────────────┐
   │ reminder_config  │  │ project_settings     │
   │ *project_id      │  │ *project_id          │
   │  overdue_days    │  │  allowed_extensions[]│
   │  digest_hour     │  │  attachment_cap_mb   │
   │  digest_enabled  │  │  autotag_*           │
   │  digest_max_n    │  │  mail_bomb_per_hour  │
   └──────────────────┘  │  disk_alert_pct      │
                         └──────────────────────┘

   Scheduler / worker dedup & heartbeats (mostly system-internal, no RLS):
   ┌──────────────────┐ ┌────────────────────┐ ┌──────────────────────┐
   │ worker_heartbeats│ │ digest_log         │ │ snooze_reminder_log  │
   │ *loop_name       │ │ *id                │ │ *id                  │
   │  last_beat_at    │ │ ~(recipient,date_vn)│ │ #ticket_id → tickets │
   │  status          │ └────────────────────┘ │ ~(ticket_id, date_vn)│
   └──────────────────┘   1 digest/person/day   └──────────────────────┘
   (NFR18)                                        1 reminder/ticket/day

   ┌──────────────────────────┐ ┌──────────────────────────┐
   │ reopen_notice_log        │ │ mail_bomb_alert_log      │
   │ *id                      │ │ *id                      │
   │ #ticket_id → tickets     │ │ #project_id → projects   │
   │  requester_email, sent_at│ │ ~(project,sender,window) │
   └──────────────────────────┘ └──────────────────────────┘
    ≤1 locked-notice/24h (M7)    1 admin alert/window (FR101)

   ┌──────────────────────────────────────────────────────────────┐
   │ audit_log    *** NOT in Drizzle — raw SQL, PARTITIONED ***    │
   │  RANGE-partitioned BY created_at (audit_log_2026, _2027, ...) │
   │  APPEND-ONLY: role `app` has INSERT/SELECT only               │
   │  (REVOKE UPDATE, DELETE). Written inside the service tx.       │
   └──────────────────────────────────────────────────────────────┘
```

---

## 5. Auth / session / anti-abuse  (`schema/auth.ts`)

```
   ┌─────────────┐
   │ users       │
   └──────┬──────┘
          │1
    ┌─────┼─────────────────┬───────────────────────┐
    ▼     ▼                 ▼                       ▼
 ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐
 │ sessions │  │ otp_codes    │  │ password_reset_tokens  │
 │ *id uuid │  │ *id uuid     │  │ *id uuid               │
 │ #user_id │  │ #user_id     │  │ #user_id               │
 │ expires_at│  │ code_hash    │  │ token_hash, used_at    │
 └──────────┘  │ attempts     │  └────────────────────────┘
  PG-backed,   └──────────────┘   single-use (FR97), hashed
  survives      hashed, TTL (FR96)
  restart

 ┌────────────────────────┐   ┌──────────────────────┐
 │ login_attempts         │   │ idempotency_keys     │   no FK — standalone.
 │ *id  bigserial         │   │ *key  text           │   Dedup sensitive HTTP
 │ ~(kind, subject)       │   │  created_at          │   mutations.
 │  kind ip|account       │   └──────────────────────┘
 │  failed_count, locked_until│
 └────────────────────────┘
   brute-force lockout (Story 1.4) — keyed by IP or email, NOT users.id
```

---

## 6. Full foreign-key index (quick reference)

```
child table                col(s)                  → parent
─────────────────────────────────────────────────────────────────────
users                      project_id              → projects.id   (nullable)
categories                 project_id              → projects.id
category_keywords          category_id             → categories.id
user_group_membership      user_id                 → users.id
user_group_membership      category_id             → categories.id
auto_assign_config         category_id  (unique)   → categories.id
auto_assign_members        config_id               → auto_assign_config.id
auto_assign_members        user_id                 → users.id
assign_cursors             category_id  (pk)       → categories.id
assign_cursors             last_user_id            → users.id
project_counters           project_id   (pk)       → projects.id
tickets                    project_id              → projects.id
tickets                    category_id             → categories.id (nullable)
tickets                    assignee_id             → users.id      (nullable)
tickets                    junked_from_category_id → categories.id (nullable)
ticket_messages            ticket_id               → tickets.id
participants               ticket_id               → tickets.id
drafts                     ticket_id               → tickets.id
drafts                     user_id                 → users.id
ticket_tags                ticket_id               → tickets.id
ticket_tags                tag_id                  → tags.id
tags                       project_id              → projects.id
tag_keywords               tag_id                  → tags.id
ticket_link                ticket_a                → tickets.id
ticket_link                ticket_b                → tickets.id
attachments                ticket_id               → tickets.id
attachments                message_id              → ticket_messages.id (nullable)
inbox_messages             project_id              → projects.id
inbox_messages             ticket_id               → tickets.id    (nullable)
outbox                     project_id              → projects.id
outbox                     ticket_id               → tickets.id    (nullable)
blocklist                  project_id              → projects.id
blocklist                  created_by              → users.id      (nullable)
junk_rules                 project_id              → projects.id
mail_bomb_counters         project_id              → projects.id
email_connections          project_id   (pk)       → projects.id
email_templates            project_id              → projects.id
reminder_config            project_id   (pk)       → projects.id
project_settings           project_id   (pk)       → projects.id
notifications              actor_id                → users.id
view_log                   actor_id                → users.id
view_log                   ticket_id               → tickets.id    (nullable)
view_log                   attachment_id           → attachments.id(nullable)
reopen_notice_log          ticket_id               → tickets.id
snooze_reminder_log        ticket_id               → tickets.id
mail_bomb_alert_log        project_id              → projects.id
sessions                   user_id                 → users.id
otp_codes                  user_id                 → users.id
password_reset_tokens      user_id                 → users.id
─────────────────────────────────────────────────────────────────────
no FK (standalone): role_capabilities, imap_cursor, project_settings*,
   worker_heartbeats, digest_log, idempotency_keys, login_attempts,
   audit_log (raw-SQL partitioned)
```

## Notes on multi-tenancy (2 projects in 1 DB)

- Every project-scoped table carries `project_id`; **RLS** + the active-project
  header (`X-Project`) scope every app query to one project. `tickets` has
  **FORCE RLS**.
- The app connects as role **`app`** (non-superuser) so RLS is enforced; a direct
  `psql -U hris` connection is **superuser → bypasses RLS** and sees both projects.
- `users.project_id` is nullable: a global SSA spans both projects; per-project
  staff are pinned to one.
