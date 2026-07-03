import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withActor, systemActor, type DbTx } from '../../infra/db/with-actor';
import {
  categories,
  categoryKeywords,
  autoAssignConfig,
  autoAssignMembers,
  assignCursors,
  userGroupMembership,
  tags,
  tagKeywords,
  ticketTags,
  tickets,
  users,
} from '../../infra/db/schema';
import type { TagKind } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';

export interface CategoryAdminView {
  id: number;
  nameVi: string;
  nameEn: string;
  isSensitive: boolean;
  isSystem: boolean;
  disabled: boolean;
  keywords: string[];
  ticketCount: number;
  autoAssign: { strategy: string; members: { userId: string; name: string; position: number }[] } | null;
}

export interface TagAdminView {
  id: number;
  name: string;
  kind: string;
  color: string | null;
  keywords: string[];
  ticketCount: number;
}

/**
 * Admin config (Story 4.6, FR86/FR87/FR22/FR32): CRUD over categories + keywords +
 * auto-assign rosters + tags. Mutations run as the system actor (these tables carry
 * no RLS) but are HARD-scoped to the caller's project in every WHERE, and audited.
 * Classification + auto-assign read these tables live, so every change is effective
 * immediately — no restart, no cache (AC1/AC3).
 */
@Injectable()
export class AdminConfigService {
  // ── Categories ──────────────────────────────────────────────────────────────
  async listCategories(projectId: number): Promise<CategoryAdminView[]> {
    return withActor(systemActor, async (tx) => {
      const cats = await tx
        .select()
        .from(categories)
        .where(eq(categories.projectId, projectId))
        .orderBy(asc(categories.isSystem), asc(categories.nameEn));
      const ids = cats.map((c) => c.id);
      if (ids.length === 0) return [];

      const kws = await tx
        .select({ categoryId: categoryKeywords.categoryId, keyword: categoryKeywords.keyword })
        .from(categoryKeywords)
        .where(inArray(categoryKeywords.categoryId, ids));
      const counts = (await tx.execute(sql`
        SELECT category_id, count(*)::int AS n FROM tickets
        WHERE category_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        GROUP BY category_id
      `)) as unknown as Array<{ category_id: number; n: number }>;
      const countBy = new Map(counts.map((c) => [Number(c.category_id), c.n]));

      const cfgs = await tx
        .select({ id: autoAssignConfig.id, categoryId: autoAssignConfig.categoryId, strategy: autoAssignConfig.strategy })
        .from(autoAssignConfig)
        .where(inArray(autoAssignConfig.categoryId, ids));
      const members = cfgs.length
        ? await tx
            .select({
              configId: autoAssignMembers.configId,
              userId: autoAssignMembers.userId,
              position: autoAssignMembers.position,
              name: users.name,
            })
            .from(autoAssignMembers)
            .innerJoin(users, eq(users.id, autoAssignMembers.userId))
            .where(inArray(autoAssignMembers.configId, cfgs.map((c) => c.id)))
        : [];

      return cats.map((c) => {
        const cfg = cfgs.find((x) => x.categoryId === c.id);
        return {
          id: c.id,
          nameVi: c.nameVi,
          nameEn: c.nameEn,
          isSensitive: c.isSensitive,
          isSystem: c.isSystem,
          disabled: c.disabled,
          keywords: kws.filter((k) => k.categoryId === c.id).map((k) => k.keyword),
          ticketCount: countBy.get(c.id) ?? 0,
          autoAssign: cfg
            ? {
                strategy: cfg.strategy,
                members: members
                  .filter((m) => m.configId === cfg.id)
                  .sort((a, b) => a.position - b.position)
                  .map((m) => ({ userId: m.userId, name: m.name, position: m.position })),
              }
            : null,
        };
      });
    });
  }

  async createCategory(
    actor: SessionUser,
    projectId: number,
    input: { nameVi: string; nameEn: string; isSensitive?: boolean; keywords?: string[] },
  ): Promise<{ id: number }> {
    return withActor(systemActor, async (tx) => {
      const [row] = await tx
        .insert(categories)
        .values({
          projectId,
          nameVi: input.nameVi,
          nameEn: input.nameEn,
          isSensitive: input.isSensitive ?? false,
        })
        .onConflictDoNothing({ target: [categories.projectId, categories.nameEn] })
        .returning({ id: categories.id });
      if (!row) throw new ConflictException('A category with that English name already exists');
      await this.replaceKeywords(tx, row.id, input.keywords ?? []);
      await this.audit(tx, actor, projectId, 'category.created', row.id, null, {
        nameVi: input.nameVi,
        nameEn: input.nameEn,
        isSensitive: input.isSensitive ?? false,
        keywords: input.keywords ?? [],
      });
      return { id: row.id };
    });
  }

  async updateCategory(
    actor: SessionUser,
    projectId: number,
    id: number,
    patch: { nameVi?: string; nameEn?: string; isSensitive?: boolean; disabled?: boolean; keywords?: string[] },
  ): Promise<{ ok: true }> {
    return withActor(systemActor, async (tx) => {
      const cat = await this.loadCategory(tx, projectId, id);
      if (cat.isSystem) throw new ForbiddenException('The system category cannot be modified'); // AC2

      const set: Record<string, unknown> = {};
      if (patch.nameVi !== undefined) set.nameVi = patch.nameVi;
      if (patch.nameEn !== undefined) set.nameEn = patch.nameEn;
      if (patch.isSensitive !== undefined) set.isSensitive = patch.isSensitive;
      if (patch.disabled !== undefined) set.disabled = patch.disabled;
      if (Object.keys(set).length) {
        await tx.update(categories).set(set).where(eq(categories.id, id));
      }
      if (patch.keywords !== undefined) await this.replaceKeywords(tx, id, patch.keywords);

      await this.audit(tx, actor, projectId, 'category.updated', id, cat, { ...patch });
      return { ok: true as const };
    });
  }

  /** Hard-delete only when no ticket references it; otherwise the caller must disable. */
  async deleteCategory(actor: SessionUser, projectId: number, id: number): Promise<{ ok: true }> {
    return withActor(systemActor, async (tx) => {
      const cat = await this.loadCategory(tx, projectId, id);
      if (cat.isSystem) throw new ForbiddenException('The system category cannot be deleted');
      const [used] = await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.categoryId, id))
        .limit(1);
      if (used) throw new ConflictException('Category has tickets — disable it instead'); // AC2

      // Clear dependents first (FK order), then the category.
      await tx.delete(categoryKeywords).where(eq(categoryKeywords.categoryId, id));
      await tx.delete(userGroupMembership).where(eq(userGroupMembership.categoryId, id));
      await tx.delete(assignCursors).where(eq(assignCursors.categoryId, id));
      const cfg = await tx
        .select({ id: autoAssignConfig.id })
        .from(autoAssignConfig)
        .where(eq(autoAssignConfig.categoryId, id));
      if (cfg[0]) {
        await tx.delete(autoAssignMembers).where(eq(autoAssignMembers.configId, cfg[0].id));
        await tx.delete(autoAssignConfig).where(eq(autoAssignConfig.id, cfg[0].id));
      }
      await tx.delete(categories).where(eq(categories.id, id));
      await this.audit(tx, actor, projectId, 'category.deleted', id, cat, null);
      return { ok: true as const };
    });
  }

  // ── Auto-assign config ──────────────────────────────────────────────────────
  async putAutoAssign(
    actor: SessionUser,
    projectId: number,
    categoryId: number,
    input: { strategy: 'round_robin' | 'least_load'; members: string[] },
  ): Promise<{ ok: true }> {
    return withActor(systemActor, async (tx) => {
      const cat = await this.loadCategory(tx, projectId, categoryId);
      if (cat.isSystem) throw new UnprocessableEntityException('"Khác" is never auto-assigned');
      // An empty roster would persist a config that silently never auto-assigns (every
      // ticket → pool_empty_roster, no warning). Reject it (P5).
      if (input.members.length === 0) {
        throw new UnprocessableEntityException('Auto-assign needs at least one member');
      }

      // Members must belong to THIS category's group (user_group_membership): the
      // auto-assign rotation is a SUBSET of the group, never a separate list. Only people
      // who can already see/handle the category may be auto-assigned its tickets —
      // otherwise a non-member would receive (and, via the assignee RLS carve-out, read)
      // tickets they have no need-to-know for, esp. sensitive ones. Add people to the
      // group in /admin/groups first.
      const groupRows = await tx
        .select({ userId: userGroupMembership.userId })
        .from(userGroupMembership)
        .where(eq(userGroupMembership.categoryId, categoryId));
      const groupSet = new Set(groupRows.map((r) => r.userId));
      for (const id of input.members) {
        if (!groupSet.has(id)) {
          throw new UnprocessableEntityException('Auto-assign members must belong to the category group');
        }
      }

      const [existing] = await tx
        .select({ id: autoAssignConfig.id })
        .from(autoAssignConfig)
        .where(eq(autoAssignConfig.categoryId, categoryId));
      let configId: number;
      if (existing) {
        configId = existing.id;
        await tx.update(autoAssignConfig).set({ strategy: input.strategy }).where(eq(autoAssignConfig.id, configId));
        await tx.delete(autoAssignMembers).where(eq(autoAssignMembers.configId, configId));
      } else {
        const [row] = await tx
          .insert(autoAssignConfig)
          .values({ categoryId, strategy: input.strategy })
          .returning({ id: autoAssignConfig.id });
        configId = row!.id;
      }
      for (let i = 0; i < input.members.length; i++) {
        await tx.insert(autoAssignMembers).values({ configId, userId: input.members[i]!, position: i });
      }
      // Reset the round-robin cursor so the new roster starts clean.
      await tx.delete(assignCursors).where(eq(assignCursors.categoryId, categoryId));

      await this.audit(tx, actor, projectId, 'category.auto_assign_set', categoryId, null, {
        strategy: input.strategy,
        members: input.members,
      });
      return { ok: true as const };
    });
  }

  // ── Tags + priority keyword rules ───────────────────────────────────────────
  async listTags(projectId: number): Promise<TagAdminView[]> {
    return withActor(systemActor, async (tx) => {
      const rows = await tx
        .select()
        .from(tags)
        .where(eq(tags.projectId, projectId))
        .orderBy(asc(tags.kind), asc(tags.name));
      const ids = rows.map((r) => r.id);
      if (!ids.length) return [];
      const kws = await tx
        .select({ tagId: tagKeywords.tagId, keyword: tagKeywords.keyword })
        .from(tagKeywords)
        .where(inArray(tagKeywords.tagId, ids));
      const counts = (await tx.execute(sql`
        SELECT tag_id, count(*)::int AS n FROM ticket_tags
        WHERE tag_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        GROUP BY tag_id
      `)) as unknown as Array<{ tag_id: number; n: number }>;
      const countBy = new Map(counts.map((c) => [Number(c.tag_id), c.n]));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        color: r.color,
        keywords: kws.filter((k) => k.tagId === r.id).map((k) => k.keyword),
        ticketCount: countBy.get(r.id) ?? 0,
      }));
    });
  }

  async createTag(
    actor: SessionUser,
    projectId: number,
    input: { name: string; kind: 'manual' | 'priority'; color?: string; keywords?: string[] },
  ): Promise<{ id: number }> {
    return withActor(systemActor, async (tx) => {
      const [row] = await tx
        .insert(tags)
        .values({ projectId, name: input.name, kind: input.kind as TagKind, color: input.color ?? null })
        .onConflictDoNothing({ target: [tags.projectId, tags.name] })
        .returning({ id: tags.id });
      if (!row) throw new ConflictException('A tag with that name already exists');
      if (input.kind === 'priority') await this.replaceTagKeywords(tx, row.id, input.keywords ?? []);
      await this.audit(tx, actor, projectId, 'tag.created', String(row.id), null, input);
      return { id: row.id };
    });
  }

  async updateTag(
    actor: SessionUser,
    projectId: number,
    id: number,
    patch: { name?: string; color?: string; keywords?: string[] },
  ): Promise<{ ok: true }> {
    return withActor(systemActor, async (tx) => {
      const tag = await this.loadTag(tx, projectId, id);
      if (tag.kind === 'auto') throw new ForbiddenException('Auto tags can only be toggled (8.4)');
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.color !== undefined) set.color = patch.color;
      if (Object.keys(set).length) await tx.update(tags).set(set).where(eq(tags.id, id));
      if (patch.keywords !== undefined && tag.kind === 'priority') {
        await this.replaceTagKeywords(tx, id, patch.keywords);
      }
      await this.audit(tx, actor, projectId, 'tag.updated', String(id), tag, patch);
      return { ok: true as const };
    });
  }

  /** Delete a manual/priority tag; if attached, the caller must confirm (it's removed
   *  from those tickets). Auto tags are never deleted (only toggled). */
  async deleteTag(
    actor: SessionUser,
    projectId: number,
    id: number,
    confirm: boolean,
  ): Promise<{ ok: true } | { needsConfirm: true; attachedTo: number }> {
    return withActor(systemActor, async (tx) => {
      const tag = await this.loadTag(tx, projectId, id);
      if (tag.kind === 'auto') throw new ForbiddenException('Auto tags cannot be deleted');
      const rows = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM ticket_tags WHERE tag_id = ${id}
      `)) as unknown as Array<{ n: number }>;
      const n = rows[0]?.n ?? 0;
      if (n > 0 && !confirm) return { needsConfirm: true as const, attachedTo: n };
      await tx.delete(ticketTags).where(eq(ticketTags.tagId, id));
      await tx.delete(tagKeywords).where(eq(tagKeywords.tagId, id));
      await tx.delete(tags).where(eq(tags.id, id));
      await this.audit(tx, actor, projectId, 'tag.deleted', String(id), tag, { removedFrom: n });
      return { ok: true as const };
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  private async loadCategory(tx: DbTx, projectId: number, id: number) {
    const [cat] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.projectId, projectId)));
    if (!cat) throw new NotFoundException('Category not found');
    return cat;
  }

  private async loadTag(tx: DbTx, projectId: number, id: number) {
    const [tag] = await tx
      .select()
      .from(tags)
      .where(and(eq(tags.id, id), eq(tags.projectId, projectId)));
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  private async replaceKeywords(tx: DbTx, categoryId: number, keywords: string[]): Promise<void> {
    await tx.delete(categoryKeywords).where(eq(categoryKeywords.categoryId, categoryId));
    for (const kw of dedupeClean(keywords)) {
      await tx
        .insert(categoryKeywords)
        .values({ categoryId, keyword: kw })
        .onConflictDoNothing({ target: [categoryKeywords.categoryId, categoryKeywords.keyword] });
    }
  }

  private async replaceTagKeywords(tx: DbTx, tagId: number, keywords: string[]): Promise<void> {
    await tx.delete(tagKeywords).where(eq(tagKeywords.tagId, tagId));
    for (const kw of dedupeClean(keywords)) {
      await tx
        .insert(tagKeywords)
        .values({ tagId, keyword: kw })
        .onConflictDoNothing({ target: [tagKeywords.tagId, tagKeywords.keyword] });
    }
  }

  private async audit(
    tx: DbTx,
    actor: SessionUser,
    projectId: number,
    action: string,
    objectId: string | number,
    oldValue: unknown,
    newValue: unknown,
  ): Promise<void> {
    await writeAudit(tx, {
      projectId,
      actorId: actor.id,
      actorLabel: actor.email,
      action,
      objectType: action.split('.')[0],
      objectId: String(objectId),
      oldValue,
      newValue,
    });
  }
}

function dedupeClean(keywords: string[]): string[] {
  return [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length > 0))];
}
