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

@Injectable()
export class AuthService {
  constructor(
    private readonly lockout: LockoutService,
    private readonly sessions: SessionService,
    private readonly otp: OtpService,
  ) {}

  async login(email: string, password: string, ip: string): Promise<LoginResult> {
    if (await this.lockout.isLocked(ip, email)) {
      throw new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await withActor(systemActor, async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.email, email));
      return row ?? null;
    });

    const ok = user ? await verifyPassword(user.passwordHash, password) : false;
    if (!user || !ok) {
      await this.lockout.recordFailures(ip, email);
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }
    if (user.disabled) {
      throw new ForbiddenException('Tài khoản đã bị vô hiệu hóa');
    }

    await this.lockout.reset(ip, email);

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
  async changePassword(userId: string, current: string, next: string): Promise<boolean> {
    const ok = await this.confirmPassword(userId, current);
    if (!ok) return false;
    await withActor(systemActor, async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: await hashPassword(next), mustChangePassword: false })
        .where(eq(users.id, userId));
    });
    return true;
  }

  async touchLastLogin(userId: string): Promise<void> {
    await withActor(systemActor, async (tx) => {
      await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
    });
  }
}
