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

const csvStrings = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(','));
    const out = parts.map((s) => s.trim()).filter((s) => s.length > 0);
    return out.length ? out : undefined;
  });

/** A VN calendar day 'YYYY-MM-DD'; the service turns it into a tz-aware bound. */
const vnDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

export const ticketListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** Worklist tabs: all | pool | mine | pending (Story 10.1 adds `pending`). */
  view: z.enum(['all', 'pool', 'mine', 'pending']).default('all'),
  /** Default = shared worklist order (FR106); `manual` enables column sorts. */
  sort: z.enum(['worklist', 'created', 'status', 'snooze']).default('worklist'),
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
  assigneeId: csvStrings,
  /** SSA-only; ignored for project-scoped roles (RLS already pins the project). */
  projectId: z.coerce.number().int().optional(),
  createdFrom: vnDay,
  createdTo: vnDay,
});

export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;
