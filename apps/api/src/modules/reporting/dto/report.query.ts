import { z } from 'zod';
import { isRealCalendarDay } from '../../tickets/dto/ticket-list.query';

/**
 * Report query (Story 10.3 + đơn 13). A VN-day window [from, to] plus the by-time
 * bucket granularity (week | month | year) and an optional assignee filter
 * (Admin/TL drill into one staff member; a Member is FORCED to self in the
 * service regardless of what they send). `.parse()` at the controller boundary.
 */
const vnDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDay, 'INVALID_DATE')
  .optional();

export const reportQuerySchema = z.object({
  from: vnDay,
  to: vnDay,
  granularity: z.enum(['week', 'month', 'year']).default('month'),
  assigneeId: z.string().uuid().optional(),
  // Comparison window for summary deltas (Report v2) — same period a year back.
  prevFrom: vnDay,
  prevTo: vnDay,
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;
