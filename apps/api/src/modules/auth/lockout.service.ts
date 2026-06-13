import { Injectable } from '@nestjs/common';
import { and, eq, sql as raw } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { loginAttempts } from '../../infra/db/schema';

const MAX_FAILS = 5;
const BASE_LOCK_SECONDS = 30; // doubles each lock step

/**
 * Progressive brute-force lockout, per IP and per account (Story 1.4).
 * Stored in Postgres so it survives restarts and is shared across processes.
 */
@Injectable()
export class LockoutService {
  /** Throws-free check: returns lockedUntil if currently locked, else null. */
  async lockedUntil(kind: 'ip' | 'account', subject: string): Promise<Date | null> {
    return withActor(systemActor, async (tx) => {
      const [row] = await tx
        .select()
        .from(loginAttempts)
        .where(and(eq(loginAttempts.kind, kind), eq(loginAttempts.subject, subject)));
      if (row?.lockedUntil && row.lockedUntil > new Date()) return row.lockedUntil;
      return null;
    });
  }

  async isLocked(ip: string, email: string): Promise<boolean> {
    const [a, b] = await Promise.all([
      this.lockedUntil('ip', ip),
      this.lockedUntil('account', email),
    ]);
    return Boolean(a || b);
  }

  /** Record a failed attempt; escalates the lock window geometrically. */
  async recordFailure(kind: 'ip' | 'account', subject: string): Promise<void> {
    await withActor(systemActor, async (tx) => {
      const [row] = await tx
        .insert(loginAttempts)
        .values({ kind, subject, failedCount: 1 })
        .onConflictDoUpdate({
          target: [loginAttempts.kind, loginAttempts.subject],
          set: {
            failedCount: raw`${loginAttempts.failedCount} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (row && row.failedCount >= MAX_FAILS) {
        const steps = row.failedCount - MAX_FAILS;
        const lockSeconds = BASE_LOCK_SECONDS * Math.pow(2, steps);
        await tx
          .update(loginAttempts)
          .set({ lockedUntil: new Date(Date.now() + lockSeconds * 1000) })
          .where(and(eq(loginAttempts.kind, kind), eq(loginAttempts.subject, subject)));
      }
    });
  }

  async recordFailures(ip: string, email: string): Promise<void> {
    await Promise.all([this.recordFailure('ip', ip), this.recordFailure('account', email)]);
  }

  /** Clear counters on successful login. */
  async reset(ip: string, email: string): Promise<void> {
    await withActor(systemActor, async (tx) => {
      await tx
        .delete(loginAttempts)
        .where(and(eq(loginAttempts.kind, 'ip'), eq(loginAttempts.subject, ip)));
      await tx
        .delete(loginAttempts)
        .where(and(eq(loginAttempts.kind, 'account'), eq(loginAttempts.subject, email)));
    });
  }
}
