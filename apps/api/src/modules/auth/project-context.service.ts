import { Injectable, ForbiddenException, BadRequestException } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { projects } from '../../infra/db/schema';
import type { SessionUser } from './session.service';

export interface ProjectRef {
  id: number;
  key: string;
  name: string;
}

/**
 * Resolves which project a request operates in (Story 1.8 AC3). The active
 * project travels in the `X-Project` header (a project key). SSA may switch
 * between projects freely; everyone else is pinned to their home project, and
 * a cross-project header is a 403 — the BE gate behind the FE switcher.
 */
@Injectable()
export class ProjectContextService {
  async list(): Promise<ProjectRef[]> {
    return withActor(systemActor, (tx) =>
      tx
        .select({ id: projects.id, key: projects.key, name: projects.name })
        .from(projects)
        .orderBy(asc(projects.id)),
    );
  }

  /** Projects the user may operate in: SSA → all, others → only their home. */
  async visibleTo(user: SessionUser): Promise<ProjectRef[]> {
    const all = await this.list();
    return user.role === 'ssa' ? all : all.filter((p) => p.id === user.projectId);
  }

  /**
   * Effective project for a request from the optional `X-Project` header.
   * - absent → the user's home project (SSA with no home → first project)
   * - present → must be a real key; a non-SSA targeting another project → 403
   */
  async resolveEffective(user: SessionUser, xProjectKey?: string): Promise<ProjectRef> {
    const all = await this.list();
    if (!xProjectKey) {
      const home = all.find((p) => p.id === user.projectId);
      if (home) return home;
      if (user.role === 'ssa' && all.length > 0) return all[0]!;
      throw new ForbiddenException('No project context');
    }
    const target = all.find((p) => p.key === xProjectKey);
    if (!target) throw new BadRequestException('Unknown project');
    if (user.role !== 'ssa' && target.id !== user.projectId) {
      throw new ForbiddenException('Cross-project access denied');
    }
    return target;
  }
}
