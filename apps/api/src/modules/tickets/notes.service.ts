import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { tickets, ticketMessages } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';

function htmlFromText(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${esc.replace(/\n/g, '<br>')}</p>`;
}

@Injectable()
export class NotesService {
  /**
   * Internal note (FR99) — a SEPARATE endpoint from reply (C3). It writes an
   * `is_internal` message with NO recipients and NEVER touches the outbox, so it
   * physically cannot leave the system. Visibility rides the ticket's RLS (a user
   * who can't see the ticket can't see its notes — AC4).
   */
  async addNote(user: SessionUser, ticketId: string, body: string): Promise<{ id: string }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({ id: tickets.id, projectId: tickets.projectId })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      if (!t) throw new NotFoundException('Ticket not found');

      const [row] = await tx
        .insert(ticketMessages)
        .values({
          ticketId,
          direction: 'outbound', // originates internally; isInternal is what matters
          isInternal: true,
          fromAddr: user.email,
          bodyText: body,
          bodyHtmlSafe: htmlFromText(body),
          // No recipients, no Message-ID — a note is not an email.
          receivedAt: new Date(), // 12.1: ordering key (a note lands where it's written)
        })
        .returning({ id: ticketMessages.id });

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.note_added',
        objectType: 'ticket',
        objectId: ticketId,
      });

      return { id: row!.id };
    });
  }
}
