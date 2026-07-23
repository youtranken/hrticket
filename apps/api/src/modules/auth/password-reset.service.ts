import { Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, isNull, desc } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { passwordResetTokens, users } from '../../infra/db/schema';
import { generateToken, sha256, hashPassword } from '../../infra/crypto/password';
import { Mailer } from '../../infra/mail/mailer';
import { SessionService } from './session.service';

const RESET_TTL_MS = 30 * 60 * 1000;
// Anti-abuse: at most one reset mail per email per this window. Bounds inbox flooding,
// SMTP-relay quota burn and unbounded token growth from a scripted `forgot` loop (M2).
// Keyed on the account (not IP) — behind nginx every request shares one proxy IP.
const RESET_COOLDOWN_MS = 2 * 60 * 1000;

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly mailer: Mailer,
    private readonly sessions: SessionService,
  ) {}

  /** Always behaves the same whether or not the email exists (no enumeration). */
  async request(email: string, baseUrl: string): Promise<void> {
    const normEmail = email.trim().toLowerCase();
    const user = await withActor(systemActor, async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.email, normEmail));
      return row ?? null;
    });
    if (!user) return; // silently no-op

    // Cooldown: if this account already has an unused token issued within the window,
    // skip issuing another / sending another mail. Still returns normally so the endpoint
    // answers identically whether or not it acted (no enumeration, no timing oracle).
    const recent = await withActor(systemActor, (tx) =>
      tx
        .select({ id: passwordResetTokens.id })
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.userId, user.id),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.createdAt, new Date(Date.now() - RESET_COOLDOWN_MS)),
          ),
        )
        .limit(1),
    );
    if (recent.length) return; // recently sent → silent no-op

    const token = generateToken(32);
    await withActor(systemActor, async (tx) => {
      await tx.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
    });
    // A mail-send failure must NOT surface to the caller: the endpoint has to answer
    // identically whether or not the address exists (no account enumeration). Swallow
    // and log — the token is already persisted, so a later retry/resend still works.
    // (Never log the token itself — CLAUDE.md #13.)
    try {
      await this.mailer.send({
        to: user.email,
        subject: 'Đặt lại mật khẩu',
        text: `Mở liên kết để đặt lại mật khẩu (hết hạn sau 30 phút): ${baseUrl}/reset?token=${token}`,
      });
    } catch (e) {
      // Log by user id, NOT the email address — an error-level log keyed on a real address
      // would leak a confirmed-valid account into the logs (CR-3 / CLAUDE.md #13). Ops still
      // get the SMTP-outage signal (error level) without the PII.
      this.logger.error(`password-reset mail failed for user ${user.id}: ${(e as Error).message}`);
    }
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
