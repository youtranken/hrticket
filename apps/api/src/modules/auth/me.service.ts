import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { userGroupMembership, roleCapabilities } from '../../infra/db/schema';
import type { SessionUser } from './session.service';

export interface MePayload {
  user: { id: string; email: string; name: string };
  role: string;
  projectId: number | null;
  groups: number[];
  capabilities: string[];
  mustChangePassword: boolean;
}

@Injectable()
export class MeService {
  async build(u: SessionUser): Promise<MePayload> {
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
        projectId: u.projectId,
        groups: groupRows.map((g) => g.categoryId),
        capabilities: capRows.map((c) => c.capability),
        mustChangePassword: u.mustChangePassword,
      };
    });
  }
}
