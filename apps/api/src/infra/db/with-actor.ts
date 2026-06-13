import { sql as raw } from 'drizzle-orm';
import { ErrorCode } from '@hris/shared';
// The ONE place that imports the raw db handle (same-dir import is intentional).
import { db, type DbTx } from './db';

// Re-exported so use-cases can type their `tx` param without importing the raw
// handle (which ESLint bans). Type-only — carries no runtime db reference.
export type { DbTx } from './db';

/** Actor context carried through every DB transaction (drives RLS). */
export type ActorContext =
  | {
      kind: 'user';
      actorId: string; // uuid
      role: 'ssa' | 'admin' | 'team_lead' | 'member';
      projectId: number;
      groups: number[]; // category ids the user belongs to
    }
  | {
      kind: 'system';
      actorId: string; // SYSTEM_UUID
    };

export class MissingActorError extends Error {
  code = ErrorCode.MISSING_ACTOR;
  constructor() {
    super('withActor called without an actor context');
  }
}

/** Stable system actor used by the worker. RLS policy grants it the scope it needs. */
export const SYSTEM_UUID = '00000000-0000-0000-0000-000000000000';
export const systemActor: ActorContext = { kind: 'system', actorId: SYSTEM_UUID };

/**
 * The SINGLE gateway to the database (architecture invariant #1).
 * Opens a transaction, sets transaction-scoped RLS session variables, runs `fn`.
 * Refuses to run without an actor.
 */
export async function withActor<T>(
  ctx: ActorContext,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  if (!ctx || !ctx.actorId) {
    throw new MissingActorError();
  }
  return db.transaction(async (tx) => {
    await tx.execute(raw`SELECT set_config('app.actor_id', ${ctx.actorId}, true)`);
    if (ctx.kind === 'user') {
      await tx.execute(raw`SELECT set_config('app.actor_role', ${ctx.role}, true)`);
      await tx.execute(raw`SELECT set_config('app.project_id', ${String(ctx.projectId)}, true)`);
      await tx.execute(
        raw`SELECT set_config('app.groups', ${ctx.groups.join(',')}, true)`,
      );
      await tx.execute(raw`SELECT set_config('app.is_system', 'false', true)`);
    } else {
      await tx.execute(raw`SELECT set_config('app.actor_role', 'system', true)`);
      await tx.execute(raw`SELECT set_config('app.is_system', 'true', true)`);
    }
    return fn(tx);
  });
}
