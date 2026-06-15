import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Phase C merged-flow smoke (Epics 7/8/10) on the live compose stack (:8080).
 * Not a deep FE-DT — it confirms every NEW screen mounts with real content and
 * no uncaught page error after the cross-epic merge. Needs SEED_DEV_USERS=true
 * fixtures (admin@dev.local / dev-password-123).
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const SHOTS = 'e2e/__screenshots__';

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/(inbox|my-tickets|pool)/, { timeout: 15000 });
}

function trackPageErrors(page: Page): string[] {
  const fatal: string[] = [];
  page.on('pageerror', (e) => fatal.push(`pageerror: ${e.message}`));
  page.on('console', (m: ConsoleMessage) => {
    // Surface console errors for visibility but don't fail on benign 4xx network noise.
    if (m.type() === 'error') console.log(`[console.error] ${m.text()}`);
  });
  return fatal;
}

test('Phase C smoke: new screens render, no uncaught error (admin)', async ({ page }) => {
  const fatal = trackPageErrors(page);
  await login(page, 'admin@dev.local');

  // Epic 10 — report dashboard (ECharts) + heading.
  await page.goto('/reports');
  await expect(page).toHaveURL(/\/reports/);
  await expect(page.getByRole('heading', { name: 'Báo cáo' })).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/phasec-reports.png`, fullPage: true });

  // Epic 7 — mail protection (blocklist / held / junk-rules tabs).
  await page.goto('/admin/mail-protection');
  await expect(page).toHaveURL(/mail-protection/);
  await expect(page.locator('.ant-tabs-tab').first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/phasec-mailprotection.png`, fullPage: true });

  // Epic 8 — attachment config form.
  await page.goto('/admin/attachments');
  await expect(page).toHaveURL(/attachments/);
  await expect(page.getByRole('heading', { name: 'Cấu hình đính kèm' })).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/phasec-attachments.png`, fullPage: true });

  // Epic 7 — Junk tab (list table renders even when empty).
  await page.goto('/junk');
  await expect(page).toHaveURL(/\/junk/);
  await expect(page.locator('.ant-table').first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/phasec-junk.png`, fullPage: true });

  // Epic 10 — pending worklist table.
  await page.goto('/pending');
  await expect(page).toHaveURL(/\/pending/);
  await expect(page.locator('.ant-table').first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/phasec-pending.png`, fullPage: true });

  // Epic 10 — Vietnamese FTS search results page.
  await page.goto('/search?q=luong');
  await expect(page).toHaveURL(/\/search/);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${SHOTS}/phasec-search.png`, fullPage: true });

  expect(fatal, fatal.join('\n')).toEqual([]);
});
