import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { blocklist, users } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { actorForUser } from '../tickets/actor';
import { addToBlocklist } from './block-sender';
import type { SessionUser } from '../auth/session.service';

export interface BlocklistEntry {
  id: number;
  email: string;
  reason: string | null;
  addedByEmail: string | null;
  createdAt: string;
  /** How many inbound mails this address has had blocked (audit-derived). */
  blockedCount: number;
}

/**
 * Admin blocklist CRUD (Story 7.1, FR100). Scope is resolved by the controller
 * (Admin → own project, SSA → X-Project); every write is audited. The blocked-mail
 * counter is derived from the partitioned audit_log (`inbox.blocked` rows), so it
 * survives without a dedicated column.
 */
@Injectable()
export class AdminBlocklistService {
  async list(user: SessionUser, projectId: number): Promise<BlocklistEntry[]> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          id: blocklist.id,
          email: blocklist.email,
          reason: blocklist.reason,
          createdAt: blocklist.createdAt,
          addedByEmail: users.email,
        })
        .from(blocklist)
        .leftJoin(users, eq(users.id, blocklist.createdBy))
        .where(eq(blocklist.projectId, projectId))
        .orderBy(desc(blocklist.createdAt));

      // Blocked-mail counts per address from the audit trail, in one grouped query
      // (case-insensitive match on the recorded `from`, scoped to this project).
      const counts = (await tx.execute(sql`
        SELECT lower(new_value->>'from') AS email, count(*)::int AS n
        FROM audit_log
        WHERE action = 'inbox.blocked' AND project_id = ${projectId}
        GROUP BY lower(new_value->>'from')
      `)) as unknown as Array<{ email: string; n: number }>;
      const byEmail = new Map(counts.map((c) => [c.email, Number(c.n)]));

      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        reason: r.reason,
        addedByEmail: r.addedByEmail,
        createdAt: r.createdAt.toISOString(),
        blockedCount: byEmail.get(r.email.toLowerCase()) ?? 0,
      }));
    });
  }

  async add(
    user: SessionUser,
    projectId: number,
    input: { email: string; reason?: string },
  ): Promise<BlocklistEntry> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      await addToBlocklist(tx, {
        projectId,
        email: input.email,
        reason: input.reason ?? null,
        createdBy: user.id,
        actorLabel: user.email,
      });
      const [row] = await this.selectOne(tx, projectId, input.email);
      return row!;
    });
  }

  async remove(user: SessionUser, projectId: number, id: number): Promise<{ ok: true }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [old] = await tx
        .select({ id: blocklist.id, email: blocklist.email })
        .from(blocklist)
        .where(and(eq(blocklist.id, id), eq(blocklist.projectId, projectId)));
      if (!old) throw new NotFoundException('Not on blocklist');
      await tx.delete(blocklist).where(and(eq(blocklist.id, id), eq(blocklist.projectId, projectId)));
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'blocklist.removed',
        objectType: 'blocklist',
        objectId: String(id),
        oldValue: { email: old.email },
      });
      return { ok: true };
    });
  }

  /** Re-read one entry (after add) with its addedBy + count, reusing the list shape. */
  private async selectOne(
    tx: Parameters<typeof writeAudit>[0],
    projectId: number,
    email: string,
  ): Promise<BlocklistEntry[]> {
    const rows = await tx
      .select({
        id: blocklist.id,
        email: blocklist.email,
        reason: blocklist.reason,
        createdAt: blocklist.createdAt,
        addedByEmail: users.email,
      })
      .from(blocklist)
      .leftJoin(users, eq(users.id, blocklist.createdBy))
      .where(
        and(eq(blocklist.projectId, projectId), sql`lower(${blocklist.email}) = lower(${email})`),
      )
      .limit(1);
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      reason: r.reason,
      addedByEmail: r.addedByEmail,
      createdAt: r.createdAt.toISOString(),
      blockedCount: 0,
    }));
  }
}
