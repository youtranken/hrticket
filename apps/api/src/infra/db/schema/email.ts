import {
  pgTable,
  bigserial,
  uuid,
  text,
  integer,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { projects, users } from './core';
import { tickets } from './tickets';
import { inboxStatusEnum, outboxStatusEnum, junkRuleKindEnum } from './enums';

/**
 * Raw inbound mail. Dedup key is COMPOSITE (message_id, mailbox) — NOT global —
 * so a cross-post to both mailboxes yields two rows (party-mode J1/M1/FR17).
 */
export const inboxMessages = pgTable(
  'inbox_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    mailbox: text('mailbox').notNull(),
    messageId: text('message_id').notNull(),
    raw: text('raw').notNull(),
    status: inboxStatusEnum('status').notNull().default('received'),
    ticketId: uuid('ticket_id').references(() => tickets.id),
    // Inbound dead-letter (mirror of outbox): a poison mail (parse/process failure)
    // is retried with backoff, then flipped to `failed` so it can never wedge the
    // head of the `received` queue and block every mail behind it.
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_inbox_message_mailbox').on(t.messageId, t.mailbox),
    index('idx_inbox_status').on(t.status),
  ],
);

/** IMAP poll cursor per mailbox (NFR8). */
export const imapCursor = pgTable('imap_cursor', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  mailbox: text('mailbox').notNull().unique(),
  folder: text('folder').notNull().default('INBOX'),
  uidvalidity: text('uidvalidity'),
  lastUid: integer('last_uid').notNull().default(0),
});

/** Outbound queue, at-least-once (NFR10). enqueue lives in infra/queue. */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    toAddrs: text('to_addrs').array().notNull(),
    ccAddrs: text('cc_addrs').array(),
    bccAddrs: text('bcc_addrs').array(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html'),
    bodyText: text('body_text'),
    headers: text('headers'), // JSON string of threading headers
    ticketId: uuid('ticket_id').references(() => tickets.id),
    messageId: text('message_id'),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    smtpDispatchedAt: timestamp('smtp_dispatched_at', { withTimezone: true }),
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_outbox_claim').on(t.status, t.nextAttemptAt)],
);

/** Blocked senders (FR100). */
export const blocklist = pgTable(
  'blocklist',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    email: text('email').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_blocklist').on(t.projectId, t.email)],
);

/** Allowlisted senders: their mail ALWAYS opens a ticket even when it carries
 *  list/bulk/auto-submitted headers (e.g. HR announcements sent via a Google Group).
 *  Exact-address, per-project — the symmetric twin of the blocklist. */
export const allowlist = pgTable(
  'allowlist',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    email: text('email').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_allowlist').on(t.projectId, t.email)],
);

/** Auto-junk rules per project (FR102). */
export const junkRules = pgTable('junk_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id),
  kind: junkRuleKindEnum('kind').notNull(),
  pattern: text('pattern').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Sliding-window mail-bomb counters per sender, per project (FR101 + party-mode W12). */
export const mailBombCounters = pgTable(
  'mail_bomb_counters',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    sender: text('sender').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [unique('uq_mailbomb').on(t.projectId, t.sender, t.windowStart)],
);

/** Per-project IMAP/SMTP connection config (FR90), password encrypted. UI-managed from Story 11.1. */
export const emailConnections = pgTable('email_connections', {
  projectId: integer('project_id')
    .primaryKey()
    .references(() => projects.id),
  imapHost: text('imap_host'),
  imapPort: integer('imap_port'),
  imapUser: text('imap_user'),
  smtpHost: text('smtp_host'),
  smtpPort: integer('smtp_port'),
  smtpUser: text('smtp_user'),
  passwordEncrypted: text('password_encrypted'),
  status: text('status').notNull().default('unknown'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
});

/** Bilingual email templates (FR53/FR92). */
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    key: text('key').notNull(), // auto_ack, digest, snooze_due, ticket_reopened, reopen_locked_notice
    subjectVi: text('subject_vi').notNull(),
    subjectEn: text('subject_en').notNull(),
    bodyVi: text('body_vi').notNull(),
    bodyEn: text('body_en').notNull(),
  },
  (t) => [unique('uq_template').on(t.projectId, t.key)],
);
