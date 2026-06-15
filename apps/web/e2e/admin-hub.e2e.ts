import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Story 11.3 (FR93) — the aggregate "Settings" hub. SSA sees every config card
 * (incl. the SSA-only role-permissions card) plus the header project switcher;
 * an Admin sees the hub WITHOUT the role-permissions card; a Member has neither
 * the menu nor route access. The scope/audit contract itself is IT-CFGSWEEP-001/002.
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';

const IGNORED = [/\[antd: compatible\]/, /React Router Future Flag/, /Failed to load resource/];

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' && !IGNORED.some((re) => re.test(m.text()))) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/(inbox|my-tickets|pool)/, { timeout: 15000 });
}

test('11.3 #1: SSA hub shows every card incl. role-permissions + the project switcher', async ({
  page,
}) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'ssa@dev.local');
  await page.goto('/admin/settings');

  await expect(page.locator('[aria-label="config-card-categories"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[aria-label="config-card-emailConnection"]')).toBeVisible();
  await expect(page.locator('[aria-label="config-card-roles"]')).toBeVisible(); // SSA-only
  // Header project switcher applies page-wide for SSA.
  await expect(page.locator('.ant-layout-header .ant-select[aria-label="Dự án"]')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/11.3-hub-ssa.png', fullPage: true });

  // A card navigates to its page.
  await page.locator('[aria-label="config-card-emailConnection"]').click();
  await expect(page).toHaveURL(/\/admin\/email-connection/);

  expect(errors).toEqual([]);
});

test('11.3 #2: Admin hub omits the SSA-only role-permissions card', async ({ page }) => {
  await login(page, 'admin@dev.local');
  await page.goto('/admin/settings');
  await expect(page.locator('[aria-label="config-card-users"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[aria-label="config-card-roles"]')).toHaveCount(0);
});

test('11.3 #3: Member has neither the Settings menu nor route access', async ({ page }) => {
  await login(page, 'member@dev.local');
  await expect(page.locator('.ant-layout-sider').getByText('Cấu hình', { exact: true })).toHaveCount(0);
  await page.goto('/admin/settings');
  await expect(page.getByText('Không có quyền truy cập')).toBeVisible({ timeout: 15000 });
});
