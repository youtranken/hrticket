import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { withActor, type DbTx } from '../../infra/db/with-actor';
import { tickets, tags, ticketTags } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { canActOnTicket } from './ticket.state-machine';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';

export interface AvailableTag {
  id: number;
  name: string;
  kind: string;
  color: string | null;
  applied: boolean;
}

/**
 * Manual tag add/remove on a ticket (FR33 tail). The ticket itself is RLS-guarded
 * (invisible → 404); a tag must belong to the SAME project as the ticket so a
 * crafted id can't graft another project's tag. Every change is audited (AC4).
 */
@Injectable()
export class TicketTagsService {
  private async loadVisibleTicket(tx: DbTx, ticketId: string) {
    const [t] = await tx
      .select({
        id: tickets.id,
        projectId: tickets.projectId,
        assigneeId: tickets.assigneeId,
        categoryId: tickets.categoryId,
        status: tickets.status,
      })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    if (!t) throw new NotFoundException('Ticket not found');
    return t;
  }

  /** Tagging is a handling action: only the assignee / TL-of-group / Admin / SSA may
   *  change tags (reuses canActOnTicket), and not on a CLOSED ticket. Mirrors the FE
   *  gate; the server is the real guard. */
  private assertCanTag(user: SessionUser, groups: number[], t: { assigneeId: string | null; categoryId: number | null; status: string }): void {
    if (t.status === 'closed') {
      throw new ForbiddenException('Cannot change tags on a closed ticket');
    }
    if (!canActOnTicket(user, groups, t)) {
      throw new ForbiddenException('Not allowed to change tags on this ticket');
    }
  }

  /** Tags available for this ticket's project, each flagged whether already applied. */
  async list(user: SessionUser, ticketId: string): Promise<AvailableTag[]> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const t = await this.loadVisibleTicket(tx, ticketId);
      const all = await tx
        .select({ id: tags.id, name: tags.name, kind: tags.kind, color: tags.color })
        .from(tags)
        .where(eq(tags.projectId, t.projectId))
        .orderBy(asc(tags.kind), asc(tags.name));
      const applied = new Set(
        (
          await tx
            .select({ tagId: ticketTags.tagId })
            .from(ticketTags)
            .where(eq(ticketTags.ticketId, ticketId))
        ).map((r) => r.tagId),
      );
      return all.map((tg) => ({ ...tg, applied: applied.has(tg.id) }));
    });
  }

  async add(user: SessionUser, ticketId: string, tagId: number): Promise<{ ok: true }> {
    const actor = await actorForUser(user);
    const groups = actor.kind === 'user' ? actor.groups : [];
    return withActor(actor, async (tx) => {
      const t = await this.loadVisibleTicket(tx, ticketId);
      this.assertCanTag(user, groups, t);
      const [tag] = await tx
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(and(eq(tags.id, tagId), eq(tags.projectId, t.projectId)));
      if (!tag) throw new NotFoundException('Tag not found');

      await tx.insert(ticketTags).values({ ticketId, tagId }).onConflictDoNothing();
      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.tag_added',
        objectType: 'ticket',
        objectId: ticketId,
        newValue: { tagId, name: tag.name },
      });
      return { ok: true as const };
    });
  }

  async remove(user: SessionUser, ticketId: string, tagId: number): Promise<{ ok: true }> {
    const actor = await actorForUser(user);
    const groups = actor.kind === 'user' ? actor.groups : [];
    return withActor(actor, async (tx) => {
      const t = await this.loadVisibleTicket(tx, ticketId);
      this.assertCanTag(user, groups, t);
      // Confirm the tag exists in-project for a meaningful audit name (and 404 otherwise).
      const [tag] = await tx
        .select({ id: tags.id, name: tags.name, kind: tags.kind })
        .from(tags)
        .where(and(inArray(tags.id, [tagId]), eq(tags.projectId, t.projectId)));
      if (!tag) throw new NotFoundException('Tag not found');
      // System tags (auto signals / priority) are applied by classification, not by hand
      // → they can't be removed manually (only manual tags can).
      if (tag.kind !== 'manual') {
        throw new ForbiddenException('System tags cannot be removed by hand');
      }

      await tx
        .delete(ticketTags)
        .where(and(eq(ticketTags.ticketId, ticketId), eq(ticketTags.tagId, tagId)));
      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.tag_removed',
        objectType: 'ticket',
        objectId: ticketId,
        newValue: { tagId, name: tag.name },
      });
      return { ok: true as const };
    });
  }
}
