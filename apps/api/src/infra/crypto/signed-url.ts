import { sign, verifySigned } from './signing';

/** Inline-file URLs expire fast — they're embedded in rendered email (3.7). */
export const FILE_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Mint a short-lived HMAC token scoping access to one attachment FOR ONE USER, so a
 *  leaked URL is useless in another session even before the RLS/session gates (HMAC + TTL). */
export function signFileToken(attachmentId: string, userId: string, now: number = Date.now()): string {
  const exp = now + FILE_TOKEN_TTL_MS;
  return sign(`${attachmentId}:${userId}:${exp}`);
}

/** True iff the token is well-formed, matches this attachment AND user, and is unexpired.
 *  attachmentId/userId are UUIDs (no ':'), so the payload splits into exactly three parts. */
export function verifyFileToken(
  attachmentId: string,
  userId: string,
  token: string,
  now: number = Date.now(),
): boolean {
  const payload = verifySigned(token);
  if (!payload) return false;
  const parts = payload.split(':');
  if (parts.length !== 3) return false;
  const [id, uid, expStr] = parts;
  const exp = Number(expStr);
  return id === attachmentId && uid === userId && Number.isFinite(exp) && exp > now;
}

/** Relative URL for embedding in sanitized HTML, bound to the viewing user. */
export function signedFileUrl(attachmentId: string, userId: string, now?: number): string {
  return `/api/files/${attachmentId}?token=${encodeURIComponent(signFileToken(attachmentId, userId, now))}`;
}
