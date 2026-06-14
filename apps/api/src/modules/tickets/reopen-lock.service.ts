import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { withActor, type DbTx } from '../../infra/db/with-actor';
import { tickets } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';
import { assertCanActOnTicket } from './ticket.state-machine';

/**
 * Reopen-lock toggle (Story 5.4, FR41). A human — never the system — decides to lock
 * a ticket that has been reopened past the warn threshold; once locked, further
 * replies append + notify "contact HR" but do not reopen (handled in the reopen
 * use-case). Untick restores normal reopen. Same authz as any lifecycle action.
 */
@Injectable()
export class ReopenLockService {
  private async load(tx: DbTx, ticketId: string) {
    const [t] = await tx
      .select({
        id: tickets.id,
        projectId: tickets.projectId,
        assigneeId: tickets.assigneeId,
        categoryId: tickets.categoryId,
        reopenLocked: tickets.reopenLocked,
      })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    if (!t) throw new NotFoundException('Ticket not found');
    return t;
  }

  async setLock(
    user: SessionUser,
    ticketId: string,
    locked: boolean,
  ): Promise<{ reopenLocked: boolean }> {
    const actor = await actorForUser(user);
    const groups = actor.kind === 'user' ? actor.groups : [];
    return withActor(actor, async (tx) => {
      const t = await this.load(tx, ticketId);
      assertCanActOnTicket(user, groups, t);

      await tx.update(tickets).set({ reopenLocked: locked }).where(eq(tickets.id, ticketId));
      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: locked ? 'ticket.reopen_locked' : 'ticket.reopen_unlocked',
        objectType: 'ticket',
        objectId: ticketId,
        oldValue: { reopenLocked: t.reopenLocked },
        newValue: { reopenLocked: locked },
      });
      return { reopenLocked: locked };
    });
  }
}
