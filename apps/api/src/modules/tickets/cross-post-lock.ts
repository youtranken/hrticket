import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { ticketLink, tickets } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';

/**
 * Cross-post coordination (FR17 extension): the same email reaching BOTH projects makes
 * two linked tickets. Handling is OPEN-HANDED — both projects may claim/reply/transition
 * their side, each mailing from its OWN mailbox; the detail view merges the two
 * conversations. (The former one-side LOCK was removed by request.) What remains is the
 * tidy-up below.
 */

/**
 * After a ticket is resolved/closed, close the cross-post sibling(s) nobody picked up
 * (pooled, no assignee, still active) — the shared request has been handled. A sibling
 * actively being worked (has an assignee) is NEVER touched. Runs under the SYSTEM actor —
 * the sibling is in the other project, beyond the acting user's RLS scope. Direct UPDATE
 * (never via changeStatus) so there is no cascade back. Returns how many were closed.
 */
export async function autoCloseLockedSiblings(
  ticketId: string,
  handledByCode: string,
  actor: { id: string; email: string },
): Promise<number> {
  return withActor(systemActor, async (tx) => {
    const links = await tx
      .select({ a: ticketLink.ticketA, b: ticketLink.ticketB })
      .from(ticketLink)
      .where(
        and(
          eq(ticketLink.kind, 'cross_post'),
          or(eq(ticketLink.ticketA, ticketId), eq(ticketLink.ticketB, ticketId)),
        ),
      );
    const siblingIds = links.map((l) => (l.a === ticketId ? l.b : l.a));
    if (siblingIds.length === 0) return 0;

    const closed = await tx
      .update(tickets)
      .set({ status: 'closed', closedAt: new Date() })
      .where(
        and(
          inArray(tickets.id, siblingIds),
          isNull(tickets.assigneeId), // only the locked/pool side — never an actively-worked one
          notInArray(tickets.status, ['closed', 'resolved']),
        ),
      )
      .returning({ id: tickets.id, projectId: tickets.projectId, ticketCode: tickets.ticketCode });

    let n = 0;
    for (const c of closed) {
      await writeAudit(tx, {
        projectId: c.projectId,
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'ticket.cross_post_auto_closed',
        objectType: 'ticket',
        objectId: c.id,
        newValue: { handledBy: handledByCode, via: 'cross_post' },
      });
      n += 1;
    }
    return n;
  });
}
