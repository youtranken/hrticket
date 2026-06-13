import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { userGroupMembership, roleCapabilities } from '../../infra/db/schema';
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

      return {
        user: { id: u.id, email: u.email, name: u.name },
        role: u.role,
        projectId: active.id,
        projectKey: active.key,
        projects,
        groups: groupRows.map((g) => g.categoryId),
        capabilities: capRows.map((c) => c.capability),
        mustChangePassword: u.mustChangePassword,
      };
    });
  }
}
