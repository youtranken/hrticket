import * as argon2 from 'argon2';
import { randomBytes, createHash } from 'node:crypto';

/** Password hashing with argon2id (CLAUDE.md invariant). */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain).catch(() => false);
}

/** A reasonably strong temporary password for admin resets (Story 1.7). */
export function generateTempPassword(): string {
  return randomBytes(12).toString('base64url');
}

/** Random high-entropy token (reset links / opaque secrets). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Stable hash for storing tokens/OTP codes (never store the plaintext). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Six-digit numeric OTP. */
export function generateOtp(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}
