import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { allowlist, users } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { actorForUser } from '../tickets/actor';
import type { SessionUser } from '../auth/session.service';

export interface AllowlistEntry {
  id: number;
  email: string;
  reason: string | null;
  addedByEmail: string | null;
  createdAt: string;
  /** How many inbound mails this address has had let through (audit-derived). */
  allowedCount: number;
}

/**
 * Admin allowlist CRUD — the symmetric twin of the blocklist. An allowlisted sender's
 * mail always opens a ticket even when it carries list/bulk/auto-submitted headers (the
 * relaxation happens in IntakeService). Scope is resolved by the controller (Admin → own
 * project, SSA → X-Project); every write is audited. The let-through counter is derived
 * from the partitioned audit_log (`inbox.allowlisted` rows).
 */
@Injectable()
export class AdminAllowlistService {
  async list(user: SessionUser, projectId: number): Promise<AllowlistEntry[]> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          id: allowlist.id,
          email: allowlist.email,
          reason: allowlist.reason,
          createdAt: allowlist.createdAt,
          addedByEmail: users.email,
        })
        .from(allowlist)
        .leftJoin(users, eq(users.id, allowlist.createdBy))
        .where(eq(allowlist.projectId, projectId))
        .orderBy(desc(allowlist.createdAt));

      const counts = (await tx.execute(sql`
        SELECT lower(new_value->>'from') AS email, count(*)::int AS n
        FROM audit_log
        WHERE action = 'inbox.allowlisted' AND project_id = ${projectId}
        GROUP BY lower(new_value->>'from')
      `)) as unknown as Array<{ email: string; n: number }>;
      const byEmail = new Map(counts.map((c) => [c.email, Number(c.n)]));

      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        reason: r.reason,
        addedByEmail: r.addedByEmail,
        createdAt: r.createdAt.toISOString(),
        allowedCount: byEmail.get(r.email.toLowerCase()) ?? 0,
      }));
    });
  }

  async add(
    user: SessionUser,
    projectId: number,
    input: { email: string; reason?: string },
  ): Promise<AllowlistEntry> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      await tx
        .insert(allowlist)
        .values({
          projectId,
          email: input.email,
          reason: input.reason ?? null,
          createdBy: user.id,
        })
        .onConflictDoNothing({ target: [allowlist.projectId, allowlist.email] });
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'allowlist.added',
        objectType: 'allowlist',
        objectId: input.email,
        newValue: { email: input.email, reason: input.reason ?? null },
      });
      const [row] = await tx
        .select({
          id: allowlist.id,
          email: allowlist.email,
          reason: allowlist.reason,
          createdAt: allowlist.createdAt,
          addedByEmail: users.email,
        })
        .from(allowlist)
        .leftJoin(users, eq(users.id, allowlist.createdBy))
        .where(
          and(eq(allowlist.projectId, projectId), sql`lower(${allowlist.email}) = lower(${input.email})`),
        )
        .limit(1);
      return {
        id: row!.id,
        email: row!.email,
        reason: row!.reason,
        addedByEmail: row!.addedByEmail,
        createdAt: row!.createdAt.toISOString(),
        allowedCount: 0,
      };
    });
  }

  async remove(user: SessionUser, projectId: number, id: number): Promise<{ ok: true }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [old] = await tx
        .select({ id: allowlist.id, email: allowlist.email })
        .from(allowlist)
        .where(and(eq(allowlist.id, id), eq(allowlist.projectId, projectId)));
      if (!old) throw new NotFoundException('Not on allowlist');
      await tx.delete(allowlist).where(and(eq(allowlist.id, id), eq(allowlist.projectId, projectId)));
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'allowlist.removed',
        objectType: 'allowlist',
        objectId: String(id),
        oldValue: { email: old.email },
      });
      return { ok: true };
    });
  }
}
