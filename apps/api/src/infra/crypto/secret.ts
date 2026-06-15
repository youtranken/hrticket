import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM symmetric encryption for at-rest secrets that must be read back as
 * plaintext to be used (unlike passwords, which are one-way hashed). Currently the
 * per-project email App Password (Story 11.1): stored as ciphertext, decrypted only
 * inside the API/worker to open an IMAP/SMTP connection — never returned to the FE
 * (GET masks to `****<last4>`) and never logged.
 *
 * Key: SHA-256 of `EMAIL_SECRET_KEY` (falls back to the always-present
 * `ATTACHMENT_ENCRYPTION_KEY` so the feature works without a new required env).
 * Read lazily per call so tests can set the env after import.
 */
const VERSION = 'v1';

function key(): Buffer {
  const s = process.env.EMAIL_SECRET_KEY ?? process.env.ATTACHMENT_ENCRYPTION_KEY ?? '';
  if (!s) throw new Error('EMAIL_SECRET_KEY (or ATTACHMENT_ENCRYPTION_KEY) is not set');
  return createHash('sha256').update(s).digest(); // 32 bytes
}

/** Returns `v1:<iv>:<tag>:<ciphertext>` (all base64). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Inverse of {@link encryptSecret}. Throws on a tampered/foreign-key blob. */
export function decryptSecret(blob: string): string {
  const [v, ivB, tagB, ctB] = blob.split(':');
  if (v !== VERSION || !ivB || !tagB || ctB === undefined) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}

/** `****<last4>` — the only form of a secret ever sent back to a client. */
export function maskSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  // For a secret of 4 chars or fewer, `slice(-4)` would reveal the whole thing — mask fully.
  return plain.length > 4 ? `****${plain.slice(-4)}` : '****';
}
