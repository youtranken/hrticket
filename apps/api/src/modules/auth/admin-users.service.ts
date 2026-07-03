import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { withActor, systemActor, type DbTx } from '../../infra/db/with-actor';
import { users, userGroupMembership, categories, projects, tickets } from '../../infra/db/schema';
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
  otpEnabled: boolean;
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
          otpEnabled: users.otpEnabled,
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

  /** Edit a user's email and/or name (FR89). Same admin scope as role/disable; email
   *  is normalised + kept unique. */
  async updateProfile(
    actor: SessionUser,
    projectId: number,
    targetId: string,
    input: { email?: string; name?: string },
  ): Promise<{ ok: true }> {
    return withActor(systemActor, async (tx) => {
      const target = await this.loadTarget(tx, targetId);
      this.assertScope(actor, projectId, target);
      const patch: { email?: string; name?: string } = {};
      if (input.name !== undefined && input.name.trim()) patch.name = input.name.trim();
      if (input.email !== undefined) {
        const email = input.email.trim().toLowerCase();
        const [dup] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.email, email), ne(users.id, targetId)));
        if (dup) throw new ConflictException('A user with that email already exists');
        patch.email = email;
      }
      if (Object.keys(patch).length === 0) return { ok: true as const };
      const [old] = await tx
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, targetId));
      await tx.update(users).set(patch).where(eq(users.id, targetId));
      await this.audit(tx, actor, projectId, 'user.profile_updated', targetId, old, patch);
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

  /**
   * Move a user to another project (SSA-only, FR — cross-project relocation). Categories
   * are project-scoped, so the user's group memberships are cleared; any non-closed ticket
   * they were assigned in the OLD project is returned to its pool (RLS pins visibility to
   * the user's project, so a kept assignment would strand the ticket). Sessions are revoked
   * so the next login resolves the new project. Never strands the old project's last admin.
   */
  async moveToProject(
    actor: SessionUser,
    targetId: string,
    newProjectId: number,
  ): Promise<{ ok: true }> {
    if (actor.role !== 'ssa') throw new ForbiddenException('Only SSA may move users between projects');
    if (targetId === actor.id) throw new ForbiddenException('You cannot move your own account');
    return withActor(systemActor, async (tx) => {
      const target = await this.loadTarget(tx, targetId);
      if (target.role === 'ssa') throw new ForbiddenException('SSA is global, not project-bound');
      if (target.projectId === newProjectId) {
        throw new ConflictException('User is already in that project');
      }
      const [proj] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, newProjectId));
      if (!proj) throw new NotFoundException('Project not found');
      // Moving the last admin out would orphan the old project.
      if (target.role === 'admin') await this.assertNotLastAdmin(tx, target.projectId, targetId);

      // Group memberships point at the OLD project's categories — clear them.
      await tx.delete(userGroupMembership).where(eq(userGroupMembership.userId, targetId));

      // Return their still-open tickets in the OLD project to the pool, else they'd be
      // assigned to someone who can no longer see them (RLS) — a stranded ticket.
      let unassigned = 0;
      if (target.projectId !== null) {
        const moved = await tx
          .update(tickets)
          .set({ assigneeId: null, assignedAt: null })
          .where(
            and(
              eq(tickets.assigneeId, targetId),
              eq(tickets.projectId, target.projectId),
              notInArray(tickets.status, ['closed', 'resolved']),
            ),
          )
          .returning({ id: tickets.id });
        unassigned = moved.length;
      }

      await tx.update(users).set({ projectId: newProjectId }).where(eq(users.id, targetId));
      await this.audit(
        tx,
        actor,
        newProjectId,
        'user.project_moved',
        targetId,
        { projectId: target.projectId },
        { projectId: newProjectId, unassignedTickets: unassigned },
      );
      // Force re-login so the session resolves the new project context cleanly.
      await this.sessions.revokeAllForUser(targetId);
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
