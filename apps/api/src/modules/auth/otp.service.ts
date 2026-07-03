import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { otpCodes, users } from '../../infra/db/schema';
import { generateOtp, sha256 } from '../../infra/crypto/password';
import { sign, verifySigned } from '../../infra/crypto/signing';
import { Mailer } from '../../infra/mail/mailer';
import { emailShell } from '../../infra/mail/email-template';

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
// Account-level brute-force cap: total wrong OTP guesses (summed across ALL codes,
// so re-issuing a fresh code can't reset it) allowed in a rolling window before every
// verify is refused. Bounds guesses to ~LOCKOUT_FAILS per window over the 1e6 space.
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_FAILS = 10;
// Resend cap: total codes issued per user in the rolling window (login + resends) —
// bounds how many OTP mails a stolen pre-auth token can trigger.
const MAX_RESENDS_PER_WINDOW = 5;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  constructor(private readonly mailer: Mailer) {}

  /** Issue an OTP for a login that passed the password step. Returns a pre-auth token. */
  async issueForLogin(userId: string, email: string): Promise<string> {
    const code = generateOtp();
    await withActor(systemActor, async (tx) => {
      await tx.insert(otpCodes).values({
        userId,
        codeHash: sha256(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      });
    });
    try {
      await this.mailer.send({
        to: email,
        subject: 'Mã đăng nhập (OTP) / Login code',
        text: `Mã OTP của bạn là ${code}. Hết hạn sau 5 phút.\nYour one-time code is ${code}. Expires in 5 minutes.`,
        html: emailShell({
          heading: 'Mã đăng nhập / Login code',
          bodyHtml:
            `<p style="margin:0 0 4px;">Mã đăng nhập một lần của bạn <span style="color:#8a93a3;">· Your one-time code:</span></p>` +
            `<div style="font-size:30px;letter-spacing:10px;font-weight:700;color:#1F3A5F;background:#EEF3FA;border:1px solid #D6E2F0;border-radius:10px;padding:16px 0;text-align:center;margin:14px 0;">${code}</div>` +
            `<p style="color:#8a93a3;margin:0;">Hết hạn sau 5 phút · Expires in 5 minutes. Nếu không phải bạn yêu cầu, hãy bỏ qua email này.</p>`,
        }),
      });
    } catch (e) {
      // SMTP failure must not surface as a raw 500 after the password was accepted —
      // return a clean, retryable error and never leak transport internals.
      this.logger.error(`OTP send failed for ${userId}: ${(e as Error)?.message}`);
      throw new ServiceUnavailableException('Không gửi được mã OTP, vui lòng thử lại sau');
    }
    // pre-auth token binds the userId; only someone who passed the password gets it.
    return sign(`otp:${userId}:${Date.now()}`);
  }

  /**
   * Re-issue a code for a valid pre-auth token (the "Gửi lại mã" button). Capped per
   * window so a stolen pre-auth token can't be used to spam the user's mailbox; the
   * wrong-guess lockout is unaffected because attempts are summed across ALL codes.
   */
  async resend(preAuthToken: string): Promise<string> {
    const payload = verifySigned(preAuthToken);
    if (!payload?.startsWith('otp:')) throw new UnauthorizedException('Phiên OTP không hợp lệ');
    const userId = payload.split(':')[1]!;

    const email = await withActor(systemActor, async (tx) => {
      const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
      const [agg] = await tx
        .select({ issued: sql<number>`count(*)::int` })
        .from(otpCodes)
        .where(and(eq(otpCodes.userId, userId), gt(otpCodes.createdAt, since)));
      if ((agg?.issued ?? 0) >= MAX_RESENDS_PER_WINDOW) {
        throw new HttpException('Đã gửi lại quá nhiều lần, vui lòng thử lại sau', 429);
      }
      const [u] = await tx
        .select({ email: users.email, disabled: users.disabled })
        .from(users)
        .where(eq(users.id, userId));
      if (!u || u.disabled) throw new UnauthorizedException('Phiên OTP không hợp lệ');
      return u.email;
    });
    return this.issueForLogin(userId, email);
  }

  /** Verify a pre-auth token + code; returns userId on success. */
  async verify(preAuthToken: string, code: string): Promise<string> {
    const payload = verifySigned(preAuthToken);
    if (!payload?.startsWith('otp:')) throw new UnauthorizedException('Phiên OTP không hợp lệ');
    const userId = payload.split(':')[1]!;

    return withActor(systemActor, async (tx) => {
      // Account lockout: sum wrong guesses across EVERY code in the window so issuing a
      // fresh code can't reset the counter (the brute-force amplification path).
      const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
      const [agg] = await tx
        .select({ fails: sql<number>`COALESCE(SUM(${otpCodes.attempts}), 0)::int` })
        .from(otpCodes)
        .where(and(eq(otpCodes.userId, userId), gt(otpCodes.createdAt, since)));
      if ((agg?.fails ?? 0) >= LOCKOUT_FAILS) {
        throw new UnauthorizedException('Mã OTP không hợp lệ hoặc đã hết hạn');
      }

      const [row] = await tx
        .select()
        .from(otpCodes)
        .where(eq(otpCodes.userId, userId))
        .orderBy(desc(otpCodes.createdAt))
        .limit(1);
      if (!row || row.expiresAt <= new Date() || row.attempts >= MAX_ATTEMPTS) {
        throw new UnauthorizedException('Mã OTP không hợp lệ hoặc đã hết hạn');
      }
      if (row.codeHash !== sha256(code)) {
        await tx
          .update(otpCodes)
          .set({ attempts: row.attempts + 1 })
          .where(eq(otpCodes.id, row.id));
        throw new UnauthorizedException('Mã OTP không đúng');
      }
      // success — clear all codes for this user
      await tx.delete(otpCodes).where(eq(otpCodes.userId, userId));
      return userId;
    });
  }

  /** Enable/disable OTP for a user after re-confirming password (handled by caller). */
  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    await withActor(systemActor, async (tx) => {
      await tx.update(users).set({ otpEnabled: enabled }).where(eq(users.id, userId));
    });
  }
}
