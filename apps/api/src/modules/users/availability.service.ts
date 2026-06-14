import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { users } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';

export interface AvailabilityInput {
  awayFrom: string | null; // 'YYYY-MM-DD' or null = available / open-ended
  awayTo: string | null;
}

export interface AvailabilityView {
  awayFrom: string | null;
  awayTo: string | null;
}

/**
 * Availability = away window (FR27). Stored as plain dates; "away right now" is
 * computed at read by auto-assign (no flip job, A.10). Setting it never touches
 * the user's currently-held tickets (FR30 — only NEW assignments are affected).
 */
@Injectable()
export class AvailabilityService {
  async setForSelf(user: SessionUser, input: AvailabilityInput): Promise<AvailabilityView> {
    return this.apply(user, user.id, input, true);
  }

  /** Admin sets it for a user IN THEIR OWN project; SSA spans both (AC2). */
  async setForUser(
    actor: SessionUser,
    targetId: string,
    input: AvailabilityInput,
  ): Promise<AvailabilityView> {
    if (actor.role !== 'admin' && actor.role !== 'ssa') throw new ForbiddenException();
    return this.apply(actor, targetId, input, false);
  }

  private async apply(
    actor: SessionUser,
    targetId: string,
    input: AvailabilityInput,
    self: boolean,
  ): Promise<AvailabilityView> {
    if (input.awayFrom && input.awayTo && input.awayTo < input.awayFrom) {
      throw new BadRequestException('awayTo must not precede awayFrom');
    }
    return withActor(systemActor, async (tx) => {
      const [target] = await tx
        .select({ id: users.id, projectId: users.projectId })
        .from(users)
        .where(eq(users.id, targetId));
      if (!target) throw new NotFoundException('User not found');

      // Admin may only manage users in their own project (SSA is cross-project).
      if (!self && actor.role === 'admin' && target.projectId !== actor.projectId) {
        throw new ForbiddenException();
      }

      await tx
        .update(users)
        .set({ awayFrom: input.awayFrom, awayTo: input.awayTo })
        .where(eq(users.id, targetId));

      await writeAudit(tx, {
        projectId: target.projectId,
        actorId: actor.id,
        actorLabel: actor.email,
        action: self ? 'user.availability_self' : 'user.availability_admin',
        objectType: 'user',
        objectId: targetId,
        newValue: { awayFrom: input.awayFrom, awayTo: input.awayTo, by: actor.email },
      });

      return { awayFrom: input.awayFrom, awayTo: input.awayTo };
    });
  }
}
