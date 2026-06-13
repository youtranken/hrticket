import { and, eq, ne, or, isNotNull } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { inboxMessages, tags, ticketTags, ticketLink } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';

const CROSS_POST_TAG = 'Cross-post';

async function getOrCreateTag(tx: DbTx, projectId: number, name: string): Promise<number> {
  const [existing] = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.projectId, projectId), eq(tags.name, name)));
  if (existing) return existing.id;
  await tx
    .insert(tags)
    .values({ projectId, name, kind: 'auto', color: '#fa8c16' })
    .onConflictDoNothing({ target: [tags.projectId, tags.name] });
  const [row] = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.projectId, projectId), eq(tags.name, name)));
  return row!.id;
}

async function tagTicket(tx: DbTx, ticketId: string, tagId: number): Promise<void> {
  await tx.insert(ticketTags).values({ ticketId, tagId }).onConflictDoNothing();
}

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

    await tagTicket(tx, opts.ticketId, await getOrCreateTag(tx, opts.projectId, CROSS_POST_TAG));
    await tagTicket(tx, sib.ticketId, await getOrCreateTag(tx, sib.projectId, CROSS_POST_TAG));

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
