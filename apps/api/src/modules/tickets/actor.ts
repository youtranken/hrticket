import { eq } from 'drizzle-orm';
import { withActor, systemActor, type ActorContext } from '../../infra/db/with-actor';
import { userGroupMembership } from '../../infra/db/schema';
import type { SessionUser } from '../auth/session.service';

/**
 * Build the RLS actor context for an authenticated user. Groups (category
 * memberships) are read under the system actor. SSA isn't project-constrained by
 * RLS (the policy grants both projects), so its projectId is nominal.
 */
export async function actorForUser(user: SessionUser): Promise<ActorContext> {
  if (user.role === 'ssa') {
    return { kind: 'user', actorId: user.id, role: 'ssa', projectId: user.projectId ?? 1, groups: [] };
  }
  const rows = await withActor(systemActor, (tx) =>
    tx
      .select({ c: userGroupMembership.categoryId })
      .from(userGroupMembership)
      .where(eq(userGroupMembership.userId, user.id)),
  );
  return {
    kind: 'user',
    actorId: user.id,
    role: user.role,
    projectId: user.projectId ?? 1,
    groups: rows.map((r) => r.c),
  };
}
