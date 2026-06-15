import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { junkRules } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { actorForUser } from '../tickets/actor';
import type { SessionUser } from '../auth/session.service';

export interface JunkRuleEntry {
  id: number;
  kind: 'keyword' | 'sender';
  pattern: string;
  createdAt: string;
}

/** Junk-rule CRUD (Story 7.3, FR102). Admin → own project; SSA → X-Project. Audited. */
@Injectable()
export class AdminJunkRulesService {
  async list(user: SessionUser, projectId: number): Promise<JunkRuleEntry[]> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          id: junkRules.id,
          kind: junkRules.kind,
          pattern: junkRules.pattern,
          createdAt: junkRules.createdAt,
        })
        .from(junkRules)
        .where(eq(junkRules.projectId, projectId))
        .orderBy(asc(junkRules.id));
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind as 'keyword' | 'sender',
        pattern: r.pattern,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  async add(
    user: SessionUser,
    projectId: number,
    input: { kind: 'keyword' | 'sender'; pattern: string },
  ): Promise<JunkRuleEntry> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .insert(junkRules)
        .values({ projectId, kind: input.kind, pattern: input.pattern.trim() })
        .returning({
          id: junkRules.id,
          kind: junkRules.kind,
          pattern: junkRules.pattern,
          createdAt: junkRules.createdAt,
        });
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'junk_rule.added',
        objectType: 'junk_rule',
        objectId: String(row!.id),
        newValue: { kind: input.kind, pattern: input.pattern.trim() },
      });
      return {
        id: row!.id,
        kind: row!.kind as 'keyword' | 'sender',
        pattern: row!.pattern,
        createdAt: row!.createdAt.toISOString(),
      };
    });
  }

  async remove(user: SessionUser, projectId: number, id: number): Promise<{ ok: true }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [old] = await tx
        .select({ id: junkRules.id, kind: junkRules.kind, pattern: junkRules.pattern })
        .from(junkRules)
        .where(and(eq(junkRules.id, id), eq(junkRules.projectId, projectId)));
      if (!old) throw new NotFoundException('Junk rule not found');
      await tx.delete(junkRules).where(and(eq(junkRules.id, id), eq(junkRules.projectId, projectId)));
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'junk_rule.removed',
        objectType: 'junk_rule',
        objectId: String(id),
        oldValue: { kind: old.kind, pattern: old.pattern },
      });
      return { ok: true };
    });
  }
}
