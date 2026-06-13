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
import { verifyPassword } from '../../infra/crypto/password';
import { LockoutService } from './lockout.service';
import { SessionService } from './session.service';

export type LoginResult =
  | { kind: 'session'; sessionId: string }
  | { kind: 'otp_required'; userId: string };

@Injectable()
export class AuthService {
  constructor(
    private readonly lockout: LockoutService,
    private readonly sessions: SessionService,
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

    // OTP gate (Story 1.5 fills the verify endpoint). When enabled, no session yet.
    if (user.otpEnabled) {
      return { kind: 'otp_required', userId: user.id };
    }

    await this.touchLastLogin(user.id);
    return { kind: 'session', sessionId: await this.sessions.create(user.id) };
  }

  async touchLastLogin(userId: string): Promise<void> {
    await withActor(systemActor, async (tx) => {
      await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
    });
  }
}
