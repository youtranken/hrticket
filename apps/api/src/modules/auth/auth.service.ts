import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { users } from '../../infra/db/schema';
import { verifyPassword, hashPassword } from '../../infra/crypto/password';
import { LockoutService } from './lockout.service';
import { SessionService } from './session.service';
import { OtpService } from './otp.service';

export type LoginResult =
  | { kind: 'session'; sessionId: string }
  | { kind: 'otp_required'; preAuthToken: string };

// A constant argon2 hash to verify against when the email is unknown, so a failed login
// does equal work whether or not the account exists (kills the timing-enumeration oracle).
// Computed once, lazily (argon2 hashing is async).
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('login-timing-equalizer');
  return dummyHashPromise;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly lockout: LockoutService,
    private readonly sessions: SessionService,
    private readonly otp: OtpService,
  ) {
    // Warm the constant-time dummy hash at boot so the FIRST unknown-email login isn't
    // measurably slower than later ones (would otherwise leak a residual timing signal).
    void dummyHash();
  }

  async login(email: string, password: string, ip: string): Promise<LoginResult> {
    // Normalize so stored (lowercased) emails match, and the lockout buckets key on a
    // single canonical form (not per exact-case string).
    const normEmail = email.trim().toLowerCase();
    const lockedUntil = await this.lockout.lockedUntilBoth(ip, normEmail);
    if (lockedUntil) {
      // Tell the user HOW LONG (P2 #6) — the FE shows the wait instead of a vague
      // "try again later".
      const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
      throw new HttpException(
        { message: 'Too many attempts, try again later', retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await withActor(systemActor, async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.email, normEmail));
      return row ?? null;
    });

    // Constant-work verify: run argon2 even when the user is missing (timing oracle).
    let ok = false;
    if (user) {
      ok = await verifyPassword(user.passwordHash, password);
    } else {
      await verifyPassword(await dummyHash(), password);
    }
    if (!user || !ok) {
      await this.lockout.recordFailures(ip, normEmail);
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }
    if (user.disabled) {
      throw new ForbiddenException('Tài khoản đã bị vô hiệu hóa');
    }

    await this.lockout.reset(ip, normEmail);

    // OTP gate (Story 1.5). When enabled, issue a code + pre-auth token; no session yet.
    if (user.otpEnabled) {
      const preAuthToken = await this.otp.issueForLogin(user.id, user.email);
      return { kind: 'otp_required', preAuthToken };
    }

    await this.touchLastLogin(user.id);
    return { kind: 'session', sessionId: await this.sessions.create(user.id) };
  }

  /** Completes an OTP login: verify code, create session. */
  async verifyOtp(preAuthToken: string, code: string): Promise<string> {
    const userId = await this.otp.verify(preAuthToken, code);
    await this.touchLastLogin(userId);
    return this.sessions.create(userId);
  }

  /** Re-confirm a user's password (for sensitive profile actions like toggling OTP). */
  async confirmPassword(userId: string, password: string): Promise<boolean> {
    const user = await withActor(systemActor, async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.id, userId));
      return row ?? null;
    });
    return user ? verifyPassword(user.passwordHash, password) : false;
  }

  /** Change own password (also clears the must-change flag). Returns false if current is wrong. */
  async changePassword(
    userId: string,
    current: string,
    next: string,
    keepSessionId?: string,
  ): Promise<boolean> {
    const ok = await this.confirmPassword(userId, current);
    if (!ok) return false;
    await withActor(systemActor, async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: await hashPassword(next), mustChangePassword: false })
        .where(eq(users.id, userId));
    });
    // A password change invalidates every OTHER session (kills a stolen one), keeping the
    // caller's current session alive so they aren't logged out of the device they used.
    if (keepSessionId) await this.sessions.revokeOthersForUser(userId, keepSessionId);
    else await this.sessions.revokeAllForUser(userId);
    return true;
  }

  async touchLastLogin(userId: string): Promise<void> {
    await withActor(systemActor, async (tx) => {
      await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
    });
  }
}
