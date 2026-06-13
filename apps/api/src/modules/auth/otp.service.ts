import { Injectable, UnauthorizedException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { otpCodes, users } from '../../infra/db/schema';
import { generateOtp, sha256 } from '../../infra/crypto/password';
import { sign, verifySigned } from '../../infra/crypto/signing';
import { Mailer } from '../../infra/mail/mailer';

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class OtpService {
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
    await this.mailer.send({
      to: email,
      subject: 'Mã đăng nhập (OTP)',
      text: `Mã OTP của bạn là ${code}. Hết hạn sau 5 phút.`,
    });
    // pre-auth token binds the userId; only someone who passed the password gets it.
    return sign(`otp:${userId}:${Date.now()}`);
  }

  /** Verify a pre-auth token + code; returns userId on success. */
  async verify(preAuthToken: string, code: string): Promise<string> {
    const payload = verifySigned(preAuthToken);
    if (!payload?.startsWith('otp:')) throw new UnauthorizedException('Phiên OTP không hợp lệ');
    const userId = payload.split(':')[1]!;

    return withActor(systemActor, async (tx) => {
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
