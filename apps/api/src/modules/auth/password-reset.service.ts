import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, desc } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { passwordResetTokens, users } from '../../infra/db/schema';
import { generateToken, sha256, hashPassword } from '../../infra/crypto/password';
import { Mailer } from '../../infra/mail/mailer';
import { SessionService } from './session.service';

const RESET_TTL_MS = 30 * 60 * 1000;

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly mailer: Mailer,
    private readonly sessions: SessionService,
  ) {}

  /** Always behaves the same whether or not the email exists (no enumeration). */
  async request(email: string, baseUrl: string): Promise<void> {
    const user = await withActor(systemActor, async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.email, email));
      return row ?? null;
    });
    if (!user) return; // silently no-op

    const token = generateToken(32);
    await withActor(systemActor, async (tx) => {
      await tx.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
    });
    await this.mailer.send({
      to: email,
      subject: 'Đặt lại mật khẩu',
      text: `Mở liên kết để đặt lại mật khẩu (hết hạn sau 30 phút): ${baseUrl}/reset?token=${token}`,
    });
  }

  /** Consume a single-use token, set the new password, revoke all sessions. */
  async reset(token: string, newPassword: string): Promise<boolean> {
    return withActor(systemActor, async (tx) => {
      const [row] = await tx
        .select()
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, sha256(token)),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(passwordResetTokens.createdAt))
        .limit(1);
      if (!row) return false;

      await tx
        .update(users)
        .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false })
        .where(eq(users.id, row.userId));
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, row.id));
      return row.userId;
    }).then(async (userId) => {
      if (typeof userId === 'string') {
        await this.sessions.revokeAllForUser(userId);
        return true;
      }
      return false;
    });
  }
}
