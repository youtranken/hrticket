import { defineConfig, devices } from '@playwright/test';

/**
 * FE-DT browser tests (Stories 1.4 / 1.8). Drives the REAL stack served by
 * docker compose (nginx web on :8080 → api). Bring it up first:
 *   docker compose up -d --build
 *   SEED_DEV_USERS=true pnpm --filter @hris/api db:seed
 * then: pnpm --filter @hris/web e2e
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts', // keep distinct from vitest's *.test.ts
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Slow the browser down for a watchable demo: run headed with E2E_SLOWMO=600.
    // Default 0 keeps CI at full speed.
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO ?? 0) },
  },
  // Desktop-first (≥1280px per the responsive scope).
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
