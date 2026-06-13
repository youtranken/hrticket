/**
 * Error catalog — the SINGLE source of truth for domain error codes.
 * A code that is not in this enum does not exist (architecture invariant #7).
 * `message` resolution happens via i18n keys, never hard-coded at throw sites.
 */
export enum ErrorCode {
  // Generic
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  NOT_FOUND = 'NOT_FOUND',
  FORBIDDEN = 'FORBIDDEN',
  CONFLICT = 'CONFLICT',
  // Data access gateway (invariant #1)
  MISSING_ACTOR = 'MISSING_ACTOR',
}

export interface AppErrorShape {
  code: ErrorCode;
  message: string;
  details?: unknown;
}
