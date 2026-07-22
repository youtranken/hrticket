import {
  pgTable,
  bigserial,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  date,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { projects, users, categories } from './core';
import { tickets } from './tickets';
import { attachments } from './attachments';
import { viewLogActionEnum } from './enums';

/**
 * NOTE: `audit_log` is NOT declared here. It is a PARTITIONED table (BY RANGE
 * created_at) which Drizzle cannot express; it is created by the custom SQL in
 * rls-and-extras.sql applied right after the generated migration. Queried via
 * raw SQL through withActor.
 */

/** View-log for sensitive categories (FR67). */
export const viewLog = pgTable(
  'view_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    ticketId: uuid('ticket_id').references(() => tickets.id),
    attachmentId: uuid('attachment_id').references(() => attachments.id),
    action: viewLogActionEnum('action').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_viewlog_ticket').on(t.ticketId)],
);

/** Reminder/digest config per project (FR45/47/49). Shared overdue threshold. */
export const reminderConfig = pgTable('reminder_config', {
  projectId: integer('project_id')
    .primaryKey()
    .references(() => projects.id),
  overdueDays: integer('overdue_days').notNull().default(3),
  digestHour: integer('digest_hour').notNull().default(8), // VN local hour
  digestMinute: integer('digest_minute').notNull().default(30), // VN local minute (đơn 12: 08:30)
  digestEnabled: boolean('digest_enabled').notNull().default(true),
  digestMaxN: integer('digest_max_n').notNull().default(20),
  /** Đơn 12: a pool ticket unclaimed for >= this many days enters the admin digest. */
  poolUnclaimedDays: integer('pool_unclaimed_days').notNull().default(2),
});

/** Dynamic per-project settings (attachment whitelist/cap, auto-tag, mail-bomb, disk). */
export const projectSettings = pgTable('project_settings', {
  projectId: integer('project_id')
    .primaryKey()
    .references(() => projects.id),
  allowedExtensions: text('allowed_extensions').array().notNull(),
  attachmentCapMb: integer('attachment_cap_mb').notNull().default(50),
  autotagAttachment: boolean('autotag_attachment').notNull().default(true),
  autotagCrosspost: boolean('autotag_crosspost').notNull().default(true),
  autotagAutoreply: boolean('autotag_autoreply').notNull().default(true),
  mailBombPerHour: integer('mail_bomb_per_hour').notNull().default(20),
  diskAlertPct: integer('disk_alert_pct').notNull().default(15),
});

/** In-app notifications (FR54). Delta-polled. */
export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    payload: text('payload'), // JSON string
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_notifications_actor_read').on(t.actorId, t.readAt)],
);

/** Worker loop heartbeats (NFR18). */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  loopName: text('loop_name').primaryKey(),
  lastBeatAt: timestamp('last_beat_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('ok'),
});

/** Digest dedup per (recipient, VN date) (party-mode A10). */
export const digestLog = pgTable(
  'digest_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recipient: text('recipient').notNull(),
    dateVn: date('date_vn').notNull(),
  },
  (t) => [unique('uq_digest').on(t.recipient, t.dateVn)],
);

/** Overdue-escalation digest dedup per (recipient TL, VN date) — one roll-up mail a
 *  day listing the overdue tickets in that lead's groups (mirrors digest_log). */
export const overdueEscalationLog = pgTable(
  'overdue_escalation_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recipient: text('recipient').notNull(),
    dateVn: date('date_vn').notNull(),
  },
  (t) => [unique('uq_overdue_escalation').on(t.recipient, t.dateVn)],
);

/** Agent canned-reply templates per project (editable by SSA/Admin/TL; everyone may
 *  USE them when composing a reply). Bodies may carry {{ticketCode}}/{{requesterName}}/
 *  {{agentName}} placeholders, substituted client-side on insert. */
export const replyTemplates = pgTable(
  'reply_templates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    body: text('body').notNull(),
    // 12.2: NULL = common template (any category); else scoped to a category so the
    // composer picker can show requester-relevant templates first.
    categoryId: integer('category_id').references(() => categories.id),
    // 12.2: soft-disable — hidden from the composer picker but kept (and re-enableable)
    // in the admin manager, instead of hard-deleting.
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_reply_templates_project').on(t.projectId),
    index('idx_reply_templates_category').on(t.projectId, t.categoryId),
  ],
);

/** "Contact HR" reopen-locked notice throttle: ≤1 notice / 24h / requester per
 *  ticket (Story 5.4 party-mode M7 — stop 50 replies = 50 mails). Time-window dedup,
 *  so no unique constraint; we query the latest sent_at within 24h. */
export const reopenNoticeLog = pgTable(
  'reopen_notice_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    requesterEmail: text('requester_email').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_reopen_notice_ticket').on(t.ticketId, t.requesterEmail)],
);

/** Snooze-reminder dedup per (ticket, VN date). */
export const snoozeReminderLog = pgTable(
  'snooze_reminder_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    dateVn: date('date_vn').notNull(),
  },
  (t) => [unique('uq_snooze_reminder').on(t.ticketId, t.dateVn)],
);

/** Mail-bomb grouped-alert dedup per (project, sender, window): the FIRST mail that
 *  crosses the threshold in a sliding window claims a row (INSERT … ON CONFLICT DO
 *  NOTHING) and sends exactly one Admin alert; later mails in the same window find the
 *  row and stay silent (Story 7.2, FR101). System-internal like the other *_log /
 *  mail_bomb_counters tables — no RLS (systemActor writes it at intake time). */
export const mailBombAlertLog = pgTable(
  'mail_bomb_alert_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    sender: text('sender').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_mailbomb_alert').on(t.projectId, t.sender, t.windowStart)],
);
