import { execSync } from 'node:child_process';

/**
 * Reset brute-force state before the run so a prior run's failed logins don't
 * leave the shared client IP locked (→ 429 instead of the expected error).
 * The e2e suite already assumes the docker compose stack is up.
 */
export default function globalSetup(): void {
  try {
    execSync(
      `${process.env.E2E_COMPOSE ?? 'docker compose'} exec -T postgres psql -U hris -d hris -c "TRUNCATE login_attempts"`,
      { cwd: '../..', stdio: 'ignore' },
    );
  } catch {
    // best-effort — if compose isn't reachable the tests will fail loudly anyway
  }
}
