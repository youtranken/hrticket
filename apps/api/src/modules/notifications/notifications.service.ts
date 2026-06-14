import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { notifications } from '../../infra/db/schema';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from '../tickets/actor';

export interface NotificationView {
  id: number;
  type: string;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: NotificationView[];
  unreadCount: number;
  /** Newest createdAt in scope (for Last-Modified / If-Modified-Since), or null. */
  latest: Date | null;
}

/**
 * In-app notification reads (Story 6.1). RLS (notifications_owner) is the gate —
 * every query runs under the user's actor, so a user only ever sees / mutates their
 * OWN rows, even via a crafted call (AC4). The list is a delta: pass `since` to get
 * only newer rows; the controller layers If-Modified-Since/304 on top.
 */
@Injectable()
export class NotificationsService {
  async list(user: SessionUser, since?: Date): Promise<NotificationList> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          id: notifications.id,
          type: notifications.type,
          payload: notifications.payload,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(since ? gt(notifications.createdAt, since) : undefined)
        .orderBy(desc(notifications.createdAt))
        .limit(50);

      const [counts] = await tx
        .select({
          unread: sql<number>`count(*) FILTER (WHERE ${notifications.readAt} IS NULL)::int`,
          // Raw max() comes back as a string from the driver — coerce to Date so it can
          // be used as a typed timestamp param (gt) and serialised consistently.
          latest: sql<string | null>`max(${notifications.createdAt})`,
        })
        .from(notifications);

      return {
        items: rows.map((r) => ({
          id: r.id,
          type: r.type,
          payload: r.payload ? (JSON.parse(r.payload) as unknown) : null,
          readAt: r.readAt ? new Date(r.readAt as unknown as string).toISOString() : null,
          createdAt: new Date(r.createdAt as unknown as string).toISOString(),
        })),
        unreadCount: counts?.unread ?? 0,
        latest: counts?.latest ? new Date(counts.latest) : null,
      };
    });
  }

  /** Mark one notification read. RLS makes a cross-user id a no-op (no leak). */
  async markRead(user: SessionUser, id: number): Promise<{ ok: true }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.id, id), isNull(notifications.readAt)));
      return { ok: true as const };
    });
  }

  async markAllRead(user: SessionUser): Promise<{ ok: true }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(isNull(notifications.readAt));
      return { ok: true as const };
    });
  }
}
