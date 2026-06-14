import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor, type DbTx } from '../../infra/db/with-actor';
import { tickets, drafts } from '../../infra/db/schema';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';

export type DraftKind = 'reply' | 'note';

export interface DraftPayload {
  body: string;
  recipients?: unknown;
}

export interface DraftView {
  body: string;
  recipients: unknown;
  updatedAt: string;
}

/**
 * Server-side compose drafts (FR105) — keyed (ticket, user, kind), so they survive
 * refresh / session timeout / device change. Strictly per-user: the drafts table has
 * an RLS owner policy (rls-and-extras.sql) AND every query filters by the actor, so
 * two people on the same ticket never see each other's draft. No audit (it's a UX
 * convenience, not a record). Reply and note drafts are independent (AC4).
 */
@Injectable()
export class DraftsService {
  private async assertTicketVisible(tx: DbTx, ticketId: string): Promise<void> {
    const [t] = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId));
    if (!t) throw new NotFoundException('Ticket not found');
  }

  async put(
    user: SessionUser,
    ticketId: string,
    kind: DraftKind,
    payload: DraftPayload,
  ): Promise<{ updatedAt: string }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      await this.assertTicketVisible(tx, ticketId);
      const updatedAt = new Date();
      await tx
        .insert(drafts)
        .values({
          ticketId,
          userId: user.id,
          kind,
          body: payload.body,
          recipientsJson: payload.recipients ? JSON.stringify(payload.recipients) : null,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [drafts.ticketId, drafts.userId, drafts.kind],
          set: {
            body: payload.body,
            recipientsJson: payload.recipients ? JSON.stringify(payload.recipients) : null,
            updatedAt,
          },
        });
      return { updatedAt: updatedAt.toISOString() };
    });
  }

  async get(user: SessionUser, ticketId: string, kind: DraftKind): Promise<DraftView | null> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .select({
          body: drafts.body,
          recipientsJson: drafts.recipientsJson,
          updatedAt: drafts.updatedAt,
          userId: drafts.userId,
        })
        .from(drafts)
        .where(
          and(
            eq(drafts.ticketId, ticketId),
            eq(drafts.userId, user.id),
            eq(drafts.kind, kind),
          ),
        );
      if (!row) return null;
      return {
        body: row.body,
        recipients: row.recipientsJson ? JSON.parse(row.recipientsJson) : null,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async remove(user: SessionUser, ticketId: string, kind: DraftKind): Promise<void> {
    const actor = await actorForUser(user);
    await withActor(actor, (tx) =>
      tx
        .delete(drafts)
        .where(
          and(
            eq(drafts.ticketId, ticketId),
            eq(drafts.userId, user.id),
            eq(drafts.kind, kind),
          ),
        ),
    );
  }
}
