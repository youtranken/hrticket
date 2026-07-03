import { z } from 'zod';
import {
  TICKET_STATUSES,
  isRealCalendarDay,
  type TicketListQuery,
} from '../../tickets/dto/ticket-list.query';

/** VN calendar day 'YYYY-MM-DD', rejecting regex-valid non-dates (→ 422 not 500). */
const vnDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDay, 'INVALID_DATE');

/**
 * Filter for the ticket export. Unlike `ticketListQuerySchema` (which parses raw
 * query-STRING params), this validates the already-typed JSON the FE sends — the
 * `TicketFilters` object with real number arrays. Output matches `TicketListQuery`
 * so it feeds straight into `listForExport`.
 */
const exportFilterSchema = z.object({
  view: z.enum(['all', 'pool', 'mine', 'pending']).default('all'),
  sort: z.enum(['worklist', 'created', 'status', 'snooze']).default('worklist'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  status: z.array(z.enum(TICKET_STATUSES)).optional(),
  categoryId: z.array(z.number().int()).optional(),
  tagId: z.array(z.number().int()).optional(),
  assigneeId: z.array(z.string()).optional(),
  projectId: z.number().int().optional(),
  createdFrom: vnDay.optional(),
  createdTo: vnDay.optional(),
});

/** Export tickets: the typed worklist filter (10.1) + the output format. */
export const exportTicketsSchema = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  lang: z.enum(['vi', 'en']).default('vi'),
  filter: exportFilterSchema.default({}),
});
export type ExportTicketsBody = z.infer<typeof exportTicketsSchema>;

/** The parsed filter is shape-compatible with TicketListQuery. */
export function asTicketListQuery(f: ExportTicketsBody['filter']): TicketListQuery {
  return f;
}

/** Export a report (matches the 10.3 dashboard tables + đơn 13 slicing). */
export const exportReportSchema = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  lang: z.enum(['vi', 'en']).default('vi'),
  kind: z.enum(['by-time', 'by-category', 'by-staff']),
  from: vnDay.optional(),
  to: vnDay.optional(),
  granularity: z.enum(['week', 'month', 'year']).default('month'),
  assigneeId: z.string().uuid().optional(),
});
export type ExportReportBody = z.infer<typeof exportReportSchema>;
