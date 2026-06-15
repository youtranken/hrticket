import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Story 9.4 (FR55) — the SSA role-capability matrix editor. SSA toggles a cell (saved
 * runtime), a locked cell shows 🔒 with a disabled switch, and a non-SSA (admin) is
 * blocked from the page. The API gate + locked enforcement are proven by IT-ROLECAP-002.
 * Needs SEED_DEV_USERS=true fixtures.
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
    if (m.type() === 'error') console.log(`[console.error] ${m.text()}`);
  });
  return fatal;
}

test('9.4 role capabilities: SSA toggles a cell, locked cell is 🔒, admin is blocked', async ({ page }) => {
  const fatal = trackPageErrors(page);
  await login(page, 'ssa@dev.local');

  await page.goto('/admin/roles');
  await expect(page.locator('.ant-card-head-title')).toHaveText('Quyền vai trò', { timeout: 15000 });

  // The "assign to others" row: Member's switch (1st role column) toggles ON.
  const assignRow = page.locator('.ant-table-row', { hasText: 'Gán ticket cho người khác' });
  await expect(assignRow).toBeVisible();
  const memberSwitch = assignRow.locator('.ant-switch').first();
  const wasOn = (await memberSwitch.getAttribute('aria-checked')) === 'true';
  await memberSwitch.click();
  await expect(page.locator('.ant-message')).toContainText('Đã lưu', { timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/9.4-capabilities.png`, fullPage: true });

  // Locked cell: "edit role capabilities" × SSA shows 🔒 and a disabled switch (AC3).
  const lockedRow = page.locator('.ant-table-row', { hasText: 'Sửa định nghĩa quyền vai trò' });
  await expect(lockedRow).toContainText('🔒');
  await expect(lockedRow.locator('.ant-switch-disabled')).toHaveCount(1);

  // Restore the toggled cell so the run is idempotent.
  await memberSwitch.click();
  await expect(page.locator('.ant-message').last()).toContainText('Đã lưu', { timeout: 10000 });
  expect(wasOn).toBe(false); // sanity: default is OFF for Member

  // A non-SSA (admin) cannot reach the page — RequireRole renders the 403 result.
  const adminCtx = await page.context().browser()!.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, 'admin@dev.local');
  await adminPage.goto('/admin/roles');
  await expect(adminPage.locator('.ant-result-403')).toBeVisible({ timeout: 15000 });
  await adminCtx.close();

  expect(fatal, fatal.join('\n')).toEqual([]);
});
