import type { ActorContext } from '../../src/infra/db/with-actor';

/** Builds a user ActorContext for tests, with sensible defaults. */
export function testUserActor(overrides: Partial<Extract<ActorContext, { kind: 'user' }>> = {}): ActorContext {
  return {
    kind: 'user',
    actorId: '11111111-1111-1111-1111-111111111111',
    role: 'member',
    projectId: 1,
    groups: [],
    ...overrides,
  };
}
