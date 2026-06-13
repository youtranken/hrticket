import * as argon2 from 'argon2';
import type { Db } from '../../src/infra/db/db';
import { users } from '../../src/infra/db/schema';
import type { Role } from '../../src/infra/db/schema';

let counter = 0;

/** Inserts a minimal user and returns its row. */
export async function makeUser(
  db: Db,
  opts: { projectId: number; role?: Role; disabled?: boolean; email?: string } = { projectId: 1 },
) {
  counter += 1;
  const passwordHash = await argon2.hash('test-password', { type: argon2.argon2id });
  const [row] = await db
    .insert(users)
    .values({
      projectId: opts.projectId,
      email: opts.email ?? `user${counter}@test.local`,
      name: `Test User ${counter}`,
      passwordHash,
      role: opts.role ?? 'member',
      disabled: opts.disabled ?? false,
    })
    .returning();
  return row;
}
