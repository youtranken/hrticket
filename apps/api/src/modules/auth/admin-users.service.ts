import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { withActor, systemActor, type DbTx } from '../../infra/db/with-actor';
import { users, userGroupMembership, categories } from '../../infra/db/schema';
import type { Role } from '../../infra/db/schema';
import { generateTempPassword, hashPassword } from '../../infra/crypto/password';
import { writeAudit } from '../../infra/audit/audit';
import { SessionService } from './session.service';
import type { SessionUser } from './session.service';

export interface AdminUserView {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: boolean;
  projectId: number | null;
  awayFrom: string | null;
  awayTo: string | null;
  lastLoginAt: string | null;
  groups: { categoryId: number; nameVi: string }[];
}

/** Roles an admin/SSA may assign through this surface. `ssa` is bootstrap-only
 *  (seed) — never minted or granted here; `admin` is SSA-only (FR64). */
const ADMIN_ASSIGNABLE: Role[] = ['team_lead', 'member'];
const SSA_ASSIGNABLE: Role[] = ['admin', 'team_lead', 'member'];

/**
 * Story 9.2 (FR62/FR63/FR64/FR89) — full user lifecycle: create (temp password +
 * forced change), disable/enable (NEVER delete — history/attribution survive), and
 * role assignment by the right rung (SSA→Admin; Admin→TL/Member; nobody promotes
 * themselves). Role + disabled are read fresh from `users` on every request
 * (SessionService.resolve), so changes take effect on the user's next request —
 * no re-login (AC4). Disabling revokes live sessions so the block is immediate (AC2).
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly sessions: SessionService) {}

  async list(projectId: number, scope: 'project' | 'all'): Promise<AdminUserView[]> {
    return withActor(systemActor, async (tx) => {
      const rows = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          disabled: users.disabled,
          projectId: users.projectId,
          awayFrom: users.awayFrom,
          awayTo: users.awayTo,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .where(scope === 'all' ? undefined : eq(users.projectId, projectId))
        .orderBy(asc(users.name));
      const ids = rows.map((r) => r.id);
      const memberships = ids.length
        ? await tx
            .select({
              userId: userGroupMembership.userId,
              categoryId: userGroupMembership.categoryId,
              nameVi: categories.nameVi,
            })
            .from(userGroupMembership)
            .innerJoin(categories, eq(categories.id, userGroupMembership.categoryId))
            .where(inArray(userGroupMembership.userId, ids))
        : [];
      return rows.map((r) => ({
        ...r,
        lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
        groups: memberships
          .filter((m) => m.userId === r.id)
          .map((m) => ({ categoryId: m.categoryId, nameVi: m.nameVi })),
      }));
    });
  }

  async createUser(
    actor: SessionUser,
    projectId: number,
    input: { email: string; name: string; role: Role; categoryIds?: number[] },
  ): Promise<{ id: string; tempPassword: string }> {
    this.assertAssignable(actor, input.role);
    const temp = generateTempPassword();
    const passwordHash = await hashPassword(temp);
    return withActor(systemActor, async (tx) => {
      if (input.categoryIds?.length) await this.assertCategoriesInProject(tx, projectId, input.categoryIds);
      const [row] = await tx
        .insert(users)
        .values({
          projectId,
          email: input.email.trim().toLowerCase(),
          name: input.name,
          passwordHash,
          role: input.role,
          mustChangePassword: true,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      if (!row) throw new ConflictException('A user with that email already exists');
      for (const c of input.categoryIds ?? []) {
        await tx.insert(userGroupMembership).values({ userId: row.id, categoryId: c }).onConflictDoNothing();
      }
      await this.audit(tx, actor, projectId, 'user.created', row.id, null, {
        email: input.email,
        name: input.name,
        role: input.role,
        categoryIds: input.categoryIds ?? [],
      });
      return { id: row.id, tempPassword: temp };
    });
  }

  async setDisabled(
    actor: SessionUser,
    projectId: number,
    targetId: string,
    disabled: boolean,
  ): Promise<{ ok: true }> {
    if (targetId === actor.id) throw new ForbiddenException('You cannot disable your own account');
    return withActor(systemActor, async (tx) => {
      const target = await this.loadTarget(tx, targetId);
      this.assertScope(actor, projectId, target);
      // A project must never be left without an active admin (only SSA reaches an
      // admin target — assertScope blocks an Admin actor first).
      if (disabled && target.role === 'admin') {
        await this.assertNotLastAdmin(tx, target.projectId, targetId);
      }
      await tx.update(users).set({ disabled }).where(eq(users.id, targetId));
      await this.audit(
        tx,
        actor,
        projectId,
        disabled ? 'user.disabled' : 'user.enabled',
        targetId,
        { disabled: target.disabled },
        { disabled },
      );
      // Kill any live session so a just-disabled user is locked out at once (AC2);
      // login itself already rejects disabled accounts (auth.service).
      if (disabled) await this.sessions.revokeAllForUser(targetId);
      return { ok: true as const };
    });
  }

  async setRole(
    actor: SessionUser,
    projectId: number,
    targetId: string,
    role: Role,
  ): Promise<{ ok: true }> {
    if (targetId === actor.id) throw new ForbiddenException('You cannot change your own role'); // AC3
    this.assertAssignable(actor, role);
    return withActor(systemActor, async (tx) => {
      const target = await this.loadTarget(tx, targetId);
      this.assertScope(actor, projectId, target);
      // Demoting the last admin would orphan the project (only SSA reaches here).
      if (target.role === 'admin' && role !== 'admin') {
        await this.assertNotLastAdmin(tx, target.projectId, targetId);
      }
      await tx.update(users).set({ role }).where(eq(users.id, targetId));
      await this.audit(tx, actor, projectId, 'user.role_changed', targetId, { role: target.role }, { role });
      return { ok: true as const };
    });
  }

  // ── scope + helpers ───────────────────────────────────────────────────────
  /** Which roles the actor is allowed to assign/create (FR64). */
  private assertAssignable(actor: SessionUser, role: Role): void {
    const allowed = actor.role === 'ssa' ? SSA_ASSIGNABLE : ADMIN_ASSIGNABLE;
    if (!allowed.includes(role)) {
      throw new ForbiddenException('You may not assign that role');
    }
  }

  /** SSA → anyone; Admin → non-admin users in their own project only (mirrors rescue). */
  private assertScope(
    actor: SessionUser,
    projectId: number,
    target: { projectId: number | null; role: string },
  ): void {
    if (actor.role === 'ssa') return;
    if (
      actor.role === 'admin' &&
      target.projectId === projectId &&
      target.role !== 'admin' &&
      target.role !== 'ssa'
    ) {
      return;
    }
    throw new ForbiddenException('Out of administrative scope');
  }

  /** Refuse an action that would leave `projectId` with zero active admins
   *  (disable/demote of the last one). FR89 — a project can't be self-orphaned. */
  private async assertNotLastAdmin(
    tx: DbTx,
    projectId: number | null,
    excludeId: string,
  ): Promise<void> {
    if (projectId === null) return; // SSA is global, not a per-project admin
    const others = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.projectId, projectId),
          eq(users.role, 'admin'),
          eq(users.disabled, false),
          ne(users.id, excludeId),
        ),
      );
    if (others.length === 0) {
      throw new ConflictException('A project must keep at least one active admin');
    }
  }

  private async loadTarget(tx: DbTx, id: string) {
    const [row] = await tx
      .select({ id: users.id, role: users.role, projectId: users.projectId, disabled: users.disabled })
      .from(users)
      .where(eq(users.id, id));
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  private async assertCategoriesInProject(tx: DbTx, projectId: number, ids: number[]): Promise<void> {
    const valid = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(inArray(categories.id, ids), eq(categories.projectId, projectId)));
    if (valid.length !== new Set(ids).size) {
      throw new ConflictException('A category is not in this project');
    }
  }

  private async audit(
    tx: DbTx,
    actor: SessionUser,
    projectId: number,
    action: string,
    objectId: string,
    oldValue: unknown,
    newValue: unknown,
  ): Promise<void> {
    await writeAudit(tx, {
      projectId,
      actorId: actor.id,
      actorLabel: actor.email,
      action,
      objectType: 'user',
      objectId,
      oldValue,
      newValue,
    });
  }
}
