import { z } from 'zod';

/**
 * Filter + ordering query for the ticket worklist (Story 10.1, FR79/FR106).
 *
 * Phase-C policy keeps `packages/shared` frozen, so this Zod schema lives in the
 * BE module and the FE mirrors the serialization in `apps/web/src/lib/tickets.ts`.
 * `.parse()` runs at the controller boundary (CONVENTIONS §6).
 *
 * Every filter rides ON TOP of RLS — the policy is still the safety net, so an
 * out-of-scope `categoryId` simply yields an empty page, never a leak (AC4).
 */

/** Six lifecycle states (mirrors ticketStatusEnum). */
export const TICKET_STATUSES = [
  'open',
  'assigned',
  'in_progress',
  'pending',
  'resolved',
  'closed',
] as const;

/** Repeatable query params arrive as `string` (one) or `string[]` (many). */
const csvNumbers = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(','));
    const nums = parts
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    return nums.length ? nums : undefined;
  });

/** Keeps ONLY well-formed UUIDs. assigneeId feeds a `uuid` column,
 *  so a non-UUID token (e.g. ?assigneeId=foo) would reach Postgres as `= 'foo'::uuid` and
 *  raise `invalid input syntax for type uuid` → unhandled 500. Dropping malformed tokens
 *  (like the `status` filter drops unknown states) keeps it a 200 empty/!filtered result;
 *  RLS stays the real guard, so no leak. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const csvUuids = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(','));
    const out = parts.map((s) => s.trim()).filter((s) => UUID_RE.test(s));
    return out.length ? out : undefined;
  });

/** True only for a real calendar day — guards against regex-valid non-dates like
 *  '2026-99-99' or '2026-02-30' that would otherwise reach Postgres `::date` and
 *  raise an unhandled 500. Shared by the report/export DTOs. */
export function isRealCalendarDay(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A VN calendar day 'YYYY-MM-DD'; the service turns it into a tz-aware bound. */
const vnDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDay, 'INVALID_DATE')
  .optional();

export const ticketListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** Worklist tabs: all | pool | mine | pending (Story 10.1 adds `pending`). */
  view: z.enum(['all', 'pool', 'mine', 'pending']).default('all'),
  /** Default = the status·freshness·urgency BAND order (new on top, closed at the
   *  bottom — the inbox-like worklist users expect). `worklist` is the priority order
   *  shared with the digest (FR106), still selectable explicitly; `created`/`status`/
   *  `snooze`/`category`/`assignee` are the manual column sorts. */
  sort: z
    .enum(['band', 'worklist', 'created', 'closed', 'status', 'snooze', 'category', 'assignee'])
    .default('band'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(','));
      const out = parts
        .map((s) => s.trim())
        .filter((s): s is (typeof TICKET_STATUSES)[number] =>
          (TICKET_STATUSES as readonly string[]).includes(s),
        );
      return out.length ? out : undefined;
    }),
  categoryId: csvNumbers,
  tagId: csvNumbers,
  assigneeId: csvUuids,
  /** SSA-only; ignored for project-scoped roles (RLS already pins the project). */
  projectId: z.coerce.number().int().optional(),
  createdFrom: vnDay,
  createdTo: vnDay,
});

export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;
