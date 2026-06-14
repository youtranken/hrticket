import { createHmac, timingSafeEqual } from 'node:crypto';

function key(): string {
  const k = process.env.HMAC_SIGNING_KEY;
  // No insecure default: a missing key must fail closed, never sign with a
  // publicly-known constant that would let anyone forge file/auth tokens.
  if (!k) throw new Error('HMAC_SIGNING_KEY is required');
  return k;
}

/** Signs a payload string → `payload.signature`. Used for pre-auth tokens, file URLs. */
export function sign(payload: string): string {
  const sig = createHmac('sha256', key()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Verifies a signed token and returns the payload, or null if invalid. */
export function verifySigned(token: string): string | null {
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = createHmac('sha256', key()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload;
}
