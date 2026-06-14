/** Cross-cutting constants shared by API + Web. */

/** Reopen count at/after which the "lock reopen" tickbox is surfaced (FR41). */
export const REOPEN_WARN_THRESHOLD = 5;

/** Default overdue/digest threshold in days, per project (FR45/FR47) — seed default. */
export const DEFAULT_OVERDUE_DAYS = 3;

/** Default soft cap on attachment size in MB (FR76) — seed default, UI-configurable. */
export const DEFAULT_ATTACHMENT_CAP_MB = 50;

/** Default mail-bomb threshold: messages per sender per hour (FR101) — seed default. */
export const DEFAULT_MAIL_BOMB_PER_HOUR = 20;

/** Inline preview thresholds — FIXED, not UI-configurable (FR77). */
export const IMAGE_PREVIEW_MAX_MB = 10;
export const PDF_PREVIEW_MAX_MB = 25;

/** The two fixed projects. */
export const PROJECTS = ['hris', 'cnb'] as const;
export type ProjectKey = (typeof PROJECTS)[number];

/** Ticket lifecycle states (FR37). */
export const TICKET_STATUSES = [
  'open',
  'assigned',
  'in_progress',
  'pending',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Canonical status → AntD Tag colour palette (party-mode S9). Defined ONCE here;
 * every FE story references this map rather than inventing colours. i18n label
 * keys are `status.<value>` in the web bundle.
 */
export const TICKET_STATUS_COLOR: Record<TicketStatus, string> = {
  open: 'default', // xám
  assigned: 'blue', // xanh dương
  in_progress: 'green', // xanh lá
  pending: 'gold', // vàng
  resolved: 'purple', // tím
  closed: '#262626', // đen
};
