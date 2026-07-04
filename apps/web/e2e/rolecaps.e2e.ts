import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Story 9.4 (FR55) — the SSA role-capability matrix editor. SSA toggles a cell (saved
 * runtime), a locked cell shows 🔒 with a disabled switch, and a non-SSA (admin) is
 * blocked from the page. The API gate + locked enforcement are proven by IT-ROLECAP-002.
 * Needs SEED_DEV_USERS=true fixtures.
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const SSA_PW = process.env.SEED_SSA_DEV_PASSWORD ?? 'Pmh@1234';
const pwFor = (email: string): string => (email.startsWith('ssa@') ? SSA_PW : DEV_PW);
const SHOTS = 'e2e/__screenshots__';

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(pwFor(email));
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

  // The "claim from pool" row: Member's switch (1st role column) is LIVE — turn it
  // OFF (confirm dialog, UX #46) then back ON. (member × assign_others is locked
  // OFF now — non-applicable cells can't serve as the toggle target.)
  const claimRow = page.locator('.ant-table-row', { hasText: 'Nhận ticket từ pool' });
  await expect(claimRow).toBeVisible();
  const memberSwitch = claimRow.locator('.ant-switch').first();
  const wasOn = (await memberSwitch.getAttribute('aria-checked')) === 'true';
  await memberSwitch.click();
  await page.locator('.ant-modal-confirm-btns').getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.ant-message')).toContainText('Đã lưu', { timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/9.4-capabilities.png`, fullPage: true });

  // Locked cells: the whole SSA column is locked ON and non-applicable cells are
  // locked OFF — "edit role capabilities" applies to SSA only, so all 4 switches
  // in that row are disabled with a lock icon (AC3 extended).
  const lockedRow = page.locator('.ant-table-row', { hasText: 'Sửa định nghĩa quyền vai trò' });
  await expect(lockedRow.locator('.anticon-lock').first()).toBeVisible();
  await expect(lockedRow.locator('.ant-switch-disabled')).toHaveCount(4);

  // Restore the toggled cell so the run is idempotent (granting needs no confirm).
  await memberSwitch.click();
  await expect(page.locator('.ant-message').last()).toContainText('Đã lưu', { timeout: 10000 });
  expect(wasOn).toBe(true); // sanity: member claims by default

  // A non-SSA (admin) cannot reach the page — RequireRole renders the 403 result.
  const adminCtx = await page.context().browser()!.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, 'admin@dev.local');
  await adminPage.goto('/admin/roles');
  await expect(adminPage.locator('.ant-result-403')).toBeVisible({ timeout: 15000 });
  await adminCtx.close();

  expect(fatal, fatal.join('\n')).toEqual([]);
});
