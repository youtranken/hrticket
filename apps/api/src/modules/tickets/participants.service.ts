import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { tickets, participants } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';

@Injectable()
export class ParticipantsService {
  /** Approve (→ active) or reject a pending participant. RLS gates ticket visibility. */
  async setStatus(
    user: SessionUser,
    ticketId: string,
    participantId: number,
    action: 'approve' | 'reject',
  ): Promise<{ status: string }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      // RLS-filtered: invisible ticket → looks absent → 404 (no existence leak).
      const [ticket] = await tx
        .select({ id: tickets.id, projectId: tickets.projectId })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      if (!ticket) throw new NotFoundException('Ticket not found');

      const [p] = await tx
        .select({ id: participants.id, email: participants.email })
        .from(participants)
        .where(and(eq(participants.id, participantId), eq(participants.ticketId, ticketId)));
      if (!p) throw new NotFoundException('Participant not found');

      const status = action === 'approve' ? 'active' : 'rejected';
      await tx.update(participants).set({ status }).where(eq(participants.id, participantId));

      await writeAudit(tx, {
        projectId: ticket.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: `participant.${action}`,
        objectType: 'participant',
        objectId: String(participantId),
        newValue: { email: p.email, status },
      });
      return { status };
    });
  }
}
