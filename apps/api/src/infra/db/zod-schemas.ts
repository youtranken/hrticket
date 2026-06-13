import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { users, tickets, ticketMessages, participants } from './schema';

/**
 * Zod schemas DERIVED from the Drizzle tables (drizzle-zod) — single source of
 * truth, no hand-written duplicate of the row shape (architecture pattern).
 * Domain/DTO request schemas compose on top of these in feature modules.
 */
export const userInsertSchema = createInsertSchema(users);
export const userSelectSchema = createSelectSchema(users);

export const ticketInsertSchema = createInsertSchema(tickets);
export const ticketSelectSchema = createSelectSchema(tickets);

export const ticketMessageInsertSchema = createInsertSchema(ticketMessages);
export const participantSelectSchema = createSelectSchema(participants);
