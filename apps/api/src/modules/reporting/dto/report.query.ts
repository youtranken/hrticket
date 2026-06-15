import { z } from 'zod';
import { isRealCalendarDay } from '../../tickets/dto/ticket-list.query';

/**
 * Report query (Story 10.3). A VN-day window [from, to]; the service turns the
 * day strings into tz-aware bounds. `.parse()` at the controller boundary.
 */
const vnDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDay, 'INVALID_DATE')
  .optional();

export const reportQuerySchema = z.object({
  from: vnDay,
  to: vnDay,
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;
