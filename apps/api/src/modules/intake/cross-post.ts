import { and, eq, ne, or, isNotNull } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { inboxMessages, ticketLink } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { AUTO_TAG, ensureTag, addTicketTag } from '../routing/auto-tag.service';

const CROSS_POST_TAG = AUTO_TAG.crossPost;

/**
 * Cross-post (FR17): the same Message-ID delivered to BOTH mailboxes yields one
 * ticket per project (dedup is per-mailbox). When the second one lands, link the
 * pair and tag both "Cross-post"; the two tickets are then handled independently.
 */
export async function linkCrossPost(
  tx: DbTx,
  opts: { ticketId: string; projectId: number; mailbox: string; messageId: string },
): Promise<void> {
  const siblings = await tx
    .select({ ticketId: inboxMessages.ticketId, projectId: inboxMessages.projectId })
    .from(inboxMessages)
    .where(
      and(
        eq(inboxMessages.messageId, opts.messageId),
        ne(inboxMessages.mailbox, opts.mailbox),
        isNotNull(inboxMessages.ticketId),
      ),
    );

  for (const sib of siblings) {
    if (!sib.ticketId) continue;

    await addTicketTag(tx, opts.ticketId, await ensureTag(tx, opts.projectId, CROSS_POST_TAG));
    await addTicketTag(tx, sib.ticketId, await ensureTag(tx, sib.projectId, CROSS_POST_TAG));

    const [exists] = await tx
      .select({ id: ticketLink.id })
      .from(ticketLink)
      .where(
        or(
          and(eq(ticketLink.ticketA, opts.ticketId), eq(ticketLink.ticketB, sib.ticketId)),
          and(eq(ticketLink.ticketA, sib.ticketId), eq(ticketLink.ticketB, opts.ticketId)),
        ),
      );
    if (!exists) {
      await tx
        .insert(ticketLink)
        .values({ ticketA: opts.ticketId, ticketB: sib.ticketId, kind: 'cross_post' });
      await writeAudit(tx, {
        projectId: opts.projectId,
        actorLabel: 'system:intake',
        action: 'ticket.cross_post_linked',
        objectType: 'ticket',
        objectId: opts.ticketId,
        newValue: { linkedTo: sib.ticketId },
      });
    }
  }
}
