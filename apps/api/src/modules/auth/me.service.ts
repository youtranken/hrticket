import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { userGroupMembership, roleCapabilities, users } from '../../infra/db/schema';
import type { SessionUser } from './session.service';
import { ProjectContextService, type ProjectRef } from './project-context.service';

export interface MePayload {
  user: { id: string; email: string; name: string };
  role: string;
  projectId: number | null;
  projectKey: string;
  projects: ProjectRef[];
  groups: number[];
  capabilities: string[];
  mustChangePassword: boolean;
  /** Per-account UI language (Story 11.2) — applied on login from any machine. */
  language: string;
  availability: { awayFrom: string | null; awayTo: string | null };
}

@Injectable()
export class MeService {
  constructor(private readonly projectCtx: ProjectContextService) {}

  /**
   * @param xProjectKey optional `X-Project` header — selects the active project.
   *        Validation (cross-project 403 for non-SSA) lives in ProjectContextService.
   */
  async build(u: SessionUser, xProjectKey?: string): Promise<MePayload> {
    // Resolve + validate the active project first (throws 403 on cross-project).
    const active = await this.projectCtx.resolveEffective(u, xProjectKey);
    const projects = await this.projectCtx.visibleTo(u);

    return withActor(systemActor, async (tx) => {
      const groupRows = await tx
        .select({ categoryId: userGroupMembership.categoryId })
        .from(userGroupMembership)
        .where(eq(userGroupMembership.userId, u.id));

      const capRows = await tx
        .select({ capability: roleCapabilities.capability })
        .from(roleCapabilities)
        .where(and(eq(roleCapabilities.role, u.role), eq(roleCapabilities.allowed, true)));

      const [av] = await tx
        .select({ awayFrom: users.awayFrom, awayTo: users.awayTo, language: users.language })
        .from(users)
        .where(eq(users.id, u.id));

      return {
        user: { id: u.id, email: u.email, name: u.name },
        role: u.role,
        projectId: active.id,
        projectKey: active.key,
        projects,
        groups: groupRows.map((g) => g.categoryId),
        capabilities: capRows.map((c) => c.capability),
        mustChangePassword: u.mustChangePassword,
        language: av?.language ?? 'vi',
        availability: { awayFrom: av?.awayFrom ?? null, awayTo: av?.awayTo ?? null },
      };
    });
  }

  /** Persist the user's UI language preference (Story 11.2 AC3). */
  async setLanguage(userId: string, language: 'vi' | 'en'): Promise<void> {
    await withActor(systemActor, (tx) =>
      tx.update(users).set({ language }).where(eq(users.id, userId)),
    );
  }
}
