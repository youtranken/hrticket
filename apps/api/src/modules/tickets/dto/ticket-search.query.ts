import { z } from 'zod';

/**
 * Query for the Vietnamese full-text search (Story 10.2, FR81). `.parse()` at the
 * controller boundary (CONVENTIONS §6). Phase-C keeps `packages/shared` frozen, so
 * the schema lives in the BE module; the FE mirrors the shape in lib/tickets.ts.
 */
export const ticketSearchQuerySchema = z.object({
  /** Raw user query — ticket code, subject/body words, or a person's name/email. */
  q: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** Result order (#20): relevance (default, code→ts_rank→newest) or column sorts. */
  sort: z.enum(['relevance', 'created', 'status']).default('relevance'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

export type TicketSearchQuery = z.infer<typeof ticketSearchQuerySchema>;
