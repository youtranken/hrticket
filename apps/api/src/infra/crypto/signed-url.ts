import { sign, verifySigned } from './signing';

/** Inline-file URLs expire fast — they're embedded in rendered email (3.7). */
export const FILE_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Mint a short-lived HMAC token scoping access to one attachment (HMAC + TTL). */
export function signFileToken(attachmentId: string, now: number = Date.now()): string {
  const exp = now + FILE_TOKEN_TTL_MS;
  return sign(`${attachmentId}:${exp}`);
}

/** True iff the token is well-formed, matches this attachment, and hasn't expired. */
export function verifyFileToken(
  attachmentId: string,
  token: string,
  now: number = Date.now(),
): boolean {
  const payload = verifySigned(token);
  if (!payload) return false;
  const sep = payload.lastIndexOf(':');
  if (sep < 0) return false;
  const id = payload.slice(0, sep);
  const exp = Number(payload.slice(sep + 1));
  return id === attachmentId && Number.isFinite(exp) && exp > now;
}

/** Relative URL for embedding in sanitized HTML. The endpoint also requires a session. */
export function signedFileUrl(attachmentId: string, now?: number): string {
  return `/api/files/${attachmentId}?token=${encodeURIComponent(signFileToken(attachmentId, now))}`;
}
