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
