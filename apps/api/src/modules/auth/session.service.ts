import { Injectable } from '@nestjs/common';
import { and, eq, ne, sql as raw } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { sessions, users } from '../../infra/db/schema';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'ssa' | 'admin' | 'team_lead' | 'member';
  projectId: number | null;
  disabled: boolean;
  mustChangePassword: boolean;
}

/** Postgres-backed sessions — survive restart, shared across processes (Story 1.4). */
@Injectable()
export class SessionService {
  async create(userId: string): Promise<string> {
    return withActor(systemActor, async (tx) => {
      const [row] = await tx
        .insert(sessions)
        .values({ userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
        .returning({ id: sessions.id });
      return row!.id;
    });
  }

  /** Returns the session's user if the session is valid + not expired, else null. */
  async resolve(sessionId: string): Promise<SessionUser | null> {
    return withActor(systemActor, async (tx) => {
      const [row] = await tx
        .select({
          expiresAt: sessions.expiresAt,
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          projectId: users.projectId,
          disabled: users.disabled,
          mustChangePassword: users.mustChangePassword,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.id, sessionId));
      if (!row || row.expiresAt <= new Date()) return null;
      // A disabled account is locked out at EVERY access point (FR63/FR65): reject any
      // still-live session too, not just new logins — defence in depth alongside the
      // session revocation on disable (Story 9.2). Without this, a session minted before
      // disable (or any path that skipped revoke) would keep working.
      if (row.disabled) return null;
      const { expiresAt: _e, ...user } = row;
      return user;
    });
  }

  async revoke(sessionId: string): Promise<void> {
    await withActor(systemActor, async (tx) => {
      await tx.delete(sessions).where(eq(sessions.id, sessionId));
    });
  }

  /** Revoke every session of a user (after password reset / rescue). */
  async revokeAllForUser(userId: string): Promise<void> {
    await withActor(systemActor, async (tx) => {
      await tx.delete(sessions).where(eq(sessions.userId, userId));
    });
  }

  /** Revoke every OTHER session of a user, keeping the caller's current one alive —
   *  used after a self-service password change so a stolen session is killed but the
   *  user isn't logged out of the device they just changed it on. */
  async revokeOthersForUser(userId: string, keepSessionId: string): Promise<void> {
    await withActor(systemActor, async (tx) => {
      await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
    });
  }

  /** Housekeeping: delete expired sessions. */
  async cleanupExpired(): Promise<number> {
    return withActor(systemActor, async (tx) => {
      const res = await tx.execute(
        raw`DELETE FROM sessions WHERE expires_at <= now()`,
      );
      return (res as unknown as { count?: number }).count ?? 0;
    });
  }
}
