import {
  pgTable,
  bigserial,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  date,
  primaryKey,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { projects, users, categories } from './core';
import {
  ticketStatusEnum,
  messageDirectionEnum,
  participantStatusEnum,
  tagKindEnum,
  draftKindEnum,
} from './enums';

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    ticketCode: text('ticket_code').notNull(), // display code "#00001", per project
    subject: text('subject').notNull(),
    requesterEmail: text('requester_email').notNull(),
    mailbox: text('mailbox').notNull(),
    categoryId: integer('category_id').references(() => categories.id),
    status: ticketStatusEnum('status').notNull().default('open'),
    assigneeId: uuid('assignee_id').references(() => users.id),
    reopenCount: integer('reopen_count').notNull().default(0),
    reopenLocked: boolean('reopen_locked').notNull().default(false),
    isJunk: boolean('is_junk').notNull().default(false),
    isSpamThread: boolean('is_spam_thread').notNull().default(false),
    junkedFromCategoryId: integer('junked_from_category_id').references(() => categories.id),
    snoozeUntil: date('snooze_until'),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }).notNull().defaultNow(),
    externalSource: text('external_source'),
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    unique('uq_tickets_code_project').on(t.projectId, t.ticketCode),
    index('idx_tickets_project').on(t.projectId),
    index('idx_tickets_assignee').on(t.assigneeId),
    index('idx_tickets_status').on(t.status),
    index('idx_tickets_category').on(t.categoryId),
  ],
);

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    direction: messageDirectionEnum('direction').notNull(),
    isInternal: boolean('is_internal').notNull().default(false), // internal note (FR99)
    fromAddr: text('from_addr').notNull(),
    toAddrs: text('to_addrs').array(),
    ccAddrs: text('cc_addrs').array(),
    bccAddrs: text('bcc_addrs').array(), // outbound only (FR8)
    bodyText: text('body_text'),
    bodyHtml: text('body_html'), // raw, kept for audit (FR19)
    bodyHtmlSafe: text('body_html_safe'), // sanitized for display (party-mode E2/3.7)
    messageId: text('message_id'), // Message-ID (FR7 — also for outbound)
    inReplyTo: text('in_reply_to'),
    references: text('references'),
    isAutoReply: boolean('is_auto_reply').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_messages_ticket').on(t.ticketId),
    index('idx_messages_message_id').on(t.messageId),
  ],
);

export const participants = pgTable(
  'participants',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    email: text('email').notNull(),
    status: participantStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_participant').on(t.ticketId, t.email)],
);

export const tags = pgTable(
  'tags',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    kind: tagKindEnum('kind').notNull().default('manual'),
    color: text('color'),
  },
  (t) => [unique('uq_tag_name').on(t.projectId, t.name)],
);

export const ticketTags = pgTable(
  'ticket_tags',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.tagId] })],
);

/** Links two tickets, e.g. cross-post pair (FR17). */
export const ticketLink = pgTable('ticket_link', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ticketA: uuid('ticket_a')
    .notNull()
    .references(() => tickets.id),
  ticketB: uuid('ticket_b')
    .notNull()
    .references(() => tickets.id),
  kind: text('kind').notNull().default('cross_post'),
});

/** Server-side compose drafts, per (ticket,user,kind) (FR105). */
export const drafts = pgTable(
  'drafts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: draftKindEnum('kind').notNull(),
    body: text('body').notNull().default(''),
    recipientsJson: text('recipients_json'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_draft').on(t.ticketId, t.userId, t.kind)],
);
