import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tickets, ticketMessages } from './tickets';
import { attachmentStatusEnum } from './enums';

/**
 * Attachments stored on filesystem by UUID (path traversal-safe); original name
 * is metadata only. write-file-before-commit protocol: status pending → stored.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    messageId: uuid('message_id').references(() => ticketMessages.id),
    fileName: text('file_name').notNull(), // original name (metadata)
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    storagePath: text('storage_path').notNull(), // UUID-based path under storage root
    contentId: text('content_id'), // inbound inline-image cid (FR12/3.7), null otherwise
    status: attachmentStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_attachments_ticket').on(t.ticketId)],
);
