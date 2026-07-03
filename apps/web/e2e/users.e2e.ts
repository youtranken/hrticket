import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Story 9.2 (FR62/FR63/FR64/FR89) — full user lifecycle is a permission-critical
 * flow → committed e2e (CLAUDE.md). Admin creates a user (temp-password modal),
 * promotes Member→Team Lead inline, then disables them. A unique email per run keeps
 * it idempotent (there is deliberately NO delete endpoint). The role-ladder guards
 * and runtime effect are proven by IT-USER-001/002/003.
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

test('9.2 user admin: create → promote → disable', async ({ page }) => {
  const fatal = trackPageErrors(page);
  const stamp = Date.now();
  const email = `e2e-user-${stamp}@dev.local`;
  await login(page, 'admin@dev.local');

  await page.goto('/admin/users');
  await expect(page.locator('.ant-card-head-title')).toHaveText('Người dùng', { timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Tạo người dùng' })).toBeVisible();

  // Create a Member.
  await page.getByRole('button', { name: 'Tạo người dùng' }).click();
  const drawer = page.locator('.ant-drawer-body');
  await drawer.locator('input').nth(0).fill(email);
  await drawer.locator('input').nth(1).fill(`E2E User ${stamp}`);
  await page.locator('.ant-drawer').getByRole('button', { name: 'Lưu' }).click();

  // Temp-password modal shows once → dismiss it.
  await expect(page.locator('.ant-modal-confirm-title')).toContainText('Mật khẩu tạm', { timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/9.2-temp-password.png` });
  await page.locator('.ant-modal-confirm-btns').getByRole('button', { name: 'OK' }).click();

  // Find the new user by email.
  await page.getByPlaceholder('Tìm theo tên/email').fill(email);
  const row = page.locator('.ant-table-row', { hasText: email });
  await expect(row).toBeVisible({ timeout: 10000 });

  // Promote Member → Team Lead via the inline role Select (now confirmed).
  await row.locator('.ant-select').click();
  await page.locator('.ant-select-item-option', { hasText: 'Trưởng nhóm' }).click();
  await page.locator('.ant-modal-confirm-btns').getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.ant-message')).toContainText('Đã đổi vai trò', { timeout: 10000 });

  // Disable the user — flip the status Switch, confirm.
  await row.locator('.ant-switch').click();
  await page.locator('.ant-modal-confirm-btns').getByRole('button', { name: 'Vô hiệu hóa' }).click();
  await expect(page.locator('.ant-message')).toContainText('Đã vô hiệu hóa', { timeout: 10000 });
  await expect(row.locator('.ant-switch')).not.toHaveClass(/ant-switch-checked/);

  expect(fatal, fatal.join('\n')).toEqual([]);
});
