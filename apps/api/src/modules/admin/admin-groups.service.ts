import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withActor, systemActor, type DbTx } from '../../infra/db/with-actor';
import { categories, userGroupMembership, users } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';

export interface GroupView {
  categoryId: number;
  nameVi: string;
  nameEn: string;
  isSensitive: boolean;
  isSystem: boolean;
  memberCount: number;
}

export interface GroupMemberView {
  id: string;
  name: string;
  email: string;
  role: string;
  disabled: boolean;
  inGroup: boolean;
}

/**
 * Story 9.1 (FR57/FR58/FR61) — assign users to category groups. A category IS a
 * permission group: membership drives ticket visibility via RLS (`app.groups`,
 * read fresh per request in `actorForUser`), so every change here is effective on
 * the user's NEXT request — no re-login, no cache (AC1/AC3).
 *
 * Mutations run as the system actor (these tables carry no RLS) but are HARD-scoped
 * to the caller's project in every WHERE, and audited. Removing a user from a group
 * deliberately does NOT touch tickets they still hold: the assignee carve-out in RLS
 * (Story 9.3) keeps work-in-progress visible (AC2 / FR59).
 */
@Injectable()
export class AdminGroupsService {
  /** All category-groups in the project with their member counts (FR57). */
  async listGroups(projectId: number): Promise<GroupView[]> {
    return withActor(systemActor, async (tx) => {
      const cats = await tx
        .select()
        .from(categories)
        .where(eq(categories.projectId, projectId))
        .orderBy(asc(categories.isSystem), asc(categories.nameEn));
      const ids = cats.map((c) => c.id);
      const countBy = new Map<number, number>();
      if (ids.length) {
        const counts = await tx
          .select({
            categoryId: userGroupMembership.categoryId,
            n: sql<number>`count(*)::int`,
          })
          .from(userGroupMembership)
          .where(inArray(userGroupMembership.categoryId, ids))
          .groupBy(userGroupMembership.categoryId);
        for (const c of counts) countBy.set(Number(c.categoryId), Number(c.n));
      }
      return cats.map((c) => ({
        categoryId: c.id,
        nameVi: c.nameVi,
        nameEn: c.nameEn,
        isSensitive: c.isSensitive,
        isSystem: c.isSystem,
        memberCount: countBy.get(c.id) ?? 0,
      }));
    });
  }

  /** Project users split in/out of a given group (FR58) — feeds the transfer list. */
  async listMembers(projectId: number, categoryId: number): Promise<GroupMemberView[]> {
    return withActor(systemActor, async (tx) => {
      await this.loadCategory(tx, projectId, categoryId);
      const rows = await tx
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          disabled: users.disabled,
          memberUserId: userGroupMembership.userId,
        })
        .from(users)
        .leftJoin(
          userGroupMembership,
          and(
            eq(userGroupMembership.userId, users.id),
            eq(userGroupMembership.categoryId, categoryId),
          ),
        )
        .where(eq(users.projectId, projectId))
        .orderBy(asc(users.name));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        disabled: r.disabled,
        inGroup: r.memberUserId !== null,
      }));
    });
  }

  /** Replace the full membership of one category group (FR58). Returns the diff. */
  async setMembers(
    actor: SessionUser,
    projectId: number,
    categoryId: number,
    userIds: string[],
  ): Promise<{ added: string[]; removed: string[] }> {
    return withActor(systemActor, async (tx) => {
      const cat = await this.loadCategory(tx, projectId, categoryId);
      await this.assertUsersInProject(tx, projectId, userIds);

      const current = await tx
        .select({ userId: userGroupMembership.userId })
        .from(userGroupMembership)
        .where(eq(userGroupMembership.categoryId, categoryId));
      const currentSet = new Set(current.map((c) => c.userId));
      const nextSet = new Set(userIds);
      const added = [...nextSet].filter((u) => !currentSet.has(u));
      const removed = [...currentSet].filter((u) => !nextSet.has(u));

      if (removed.length) {
        await tx
          .delete(userGroupMembership)
          .where(
            and(
              eq(userGroupMembership.categoryId, categoryId),
              inArray(userGroupMembership.userId, removed),
            ),
          );
      }
      for (const u of added) {
        await tx.insert(userGroupMembership).values({ userId: u, categoryId }).onConflictDoNothing();
      }

      await this.audit(
        tx,
        actor,
        projectId,
        'group.members_set',
        categoryId,
        { nameEn: cat.nameEn, members: [...currentSet] },
        { members: userIds, added, removed },
      );
      return { added, removed };
    });
  }

  /** Reverse direction (FR58): the category groups a single user belongs to. */
  async listUserGroups(projectId: number, userId: string): Promise<number[]> {
    return withActor(systemActor, async (tx) => {
      await this.loadUser(tx, projectId, userId);
      const rows = await tx
        .select({ categoryId: userGroupMembership.categoryId })
        .from(userGroupMembership)
        .innerJoin(categories, eq(categories.id, userGroupMembership.categoryId))
        .where(and(eq(userGroupMembership.userId, userId), eq(categories.projectId, projectId)));
      return rows.map((r) => r.categoryId);
    });
  }

  /** Reverse direction (FR58): replace the full set of groups a user belongs to. */
  async setUserGroups(
    actor: SessionUser,
    projectId: number,
    userId: string,
    categoryIds: number[],
  ): Promise<{ added: number[]; removed: number[] }> {
    return withActor(systemActor, async (tx) => {
      const u = await this.loadUser(tx, projectId, userId);
      // Every target category must live in this project.
      if (categoryIds.length) {
        const valid = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(and(inArray(categories.id, categoryIds), eq(categories.projectId, projectId)));
        if (valid.length !== new Set(categoryIds).size) {
          throw new UnprocessableEntityException('A category is not in this project');
        }
      }
      // Only diff within THIS project's categories — never touch the other project's rows.
      const projectCatIds = (
        await tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.projectId, projectId))
      ).map((c) => c.id);
      const current = projectCatIds.length
        ? await tx
            .select({ categoryId: userGroupMembership.categoryId })
            .from(userGroupMembership)
            .where(
              and(
                eq(userGroupMembership.userId, userId),
                inArray(userGroupMembership.categoryId, projectCatIds),
              ),
            )
        : [];
      const currentSet = new Set(current.map((c) => c.categoryId));
      const nextSet = new Set(categoryIds);
      const added = [...nextSet].filter((c) => !currentSet.has(c));
      const removed = [...currentSet].filter((c) => !nextSet.has(c));

      if (removed.length) {
        await tx
          .delete(userGroupMembership)
          .where(
            and(
              eq(userGroupMembership.userId, userId),
              inArray(userGroupMembership.categoryId, removed),
            ),
          );
      }
      for (const c of added) {
        await tx.insert(userGroupMembership).values({ userId, categoryId: c }).onConflictDoNothing();
      }

      await this.audit(
        tx,
        actor,
        projectId,
        'group.user_groups_set',
        userId,
        { email: u.email, categoryIds: [...currentSet] },
        { categoryIds, added, removed },
      );
      return { added, removed };
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

  private async loadUser(tx: DbTx, projectId: number, id: string) {
    const [u] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.id, id), eq(users.projectId, projectId)));
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  private async assertUsersInProject(tx: DbTx, projectId: number, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const valid = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, userIds), eq(users.projectId, projectId)));
    if (valid.length !== new Set(userIds).size) {
      throw new UnprocessableEntityException('A user is not in this project');
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
