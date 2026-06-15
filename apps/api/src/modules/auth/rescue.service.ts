import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { users } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { generateTempPassword, hashPassword } from '../../infra/crypto/password';
import { SessionService } from './session.service';
import type { SessionUser } from './session.service';

@Injectable()
export class RescueService {
  constructor(private readonly sessions: SessionService) {}

  private async getTarget(targetId: string) {
    const target = await withActor(systemActor, async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.id, targetId));
      return row ?? null;
    });
    if (!target) throw new NotFoundException('User not found');
    return target;
  }

  /** Scope rule: SSA → anyone; Admin → non-admin users in their own project only. */
  private assertScope(actor: SessionUser, target: { projectId: number | null; role: string }) {
    if (actor.role === 'ssa') return;
    if (actor.role === 'admin') {
      if (target.projectId === actor.projectId && target.role !== 'admin' && target.role !== 'ssa') {
        return;
      }
    }
    throw new ForbiddenException('Out of administrative scope');
  }

  /** Reset a user's password to a one-time temp, force change on next login. */
  async resetPassword(actor: SessionUser, targetId: string): Promise<string> {
    const target = await this.getTarget(targetId);
    this.assertScope(actor, target);
    const temp = generateTempPassword();
    await withActor(systemActor, async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: await hashPassword(temp), mustChangePassword: true })
        .where(eq(users.id, targetId));
      // Privileged security mutation — must leave an audit trail (FR94 / invariant #8).
      // Never record the password itself (#13).
      await writeAudit(tx, {
        projectId: target.projectId,
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'user.password_reset',
        objectType: 'user',
        objectId: targetId,
        newValue: { mustChangePassword: true },
      });
    });
    await this.sessions.revokeAllForUser(targetId);
    return temp; // shown once to the admin
  }

  async removeOtp(actor: SessionUser, targetId: string): Promise<void> {
    const target = await this.getTarget(targetId);
    this.assertScope(actor, target);
    await withActor(systemActor, async (tx) => {
      await tx.update(users).set({ otpEnabled: false }).where(eq(users.id, targetId));
      await writeAudit(tx, {
        projectId: target.projectId,
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'user.otp_removed',
        objectType: 'user',
        objectId: targetId,
        newValue: { otpEnabled: false },
      });
    });
  }
}
