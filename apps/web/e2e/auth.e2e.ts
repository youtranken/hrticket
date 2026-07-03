import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * FE-DT scenarios for Story 1.4 (login + i18n) and Story 1.8 (sidebar by role,
 * 403 guard, SSA project switcher). Runs against the live compose stack with
 * SEED_DEV_USERS=true fixtures (member/lead/admin/ssa @dev.local, pw dev-password-123).
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
// SSA accounts use a memorable shared password (set out-of-band); dev users keep the seed default.
const SSA_PW = process.env.SEED_SSA_DEV_PASSWORD ?? 'Pmh@1234';
const pwFor = (email: string): string => (email.startsWith('ssa@') ? SSA_PW : DEV_PW);

// Ignore non-app console noise: AntD's one-time React-19 compat notice, router
// future-flag warnings, and the browser's own "Failed to load resource" line for
// expected 4xx responses (e.g. a 401 on wrong credentials). Fail on anything else.
const IGNORED = [
  /\[antd: compatible\]/,
  /React Router Future Flag/,
  /Failed to load resource/,
];

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' && !IGNORED.some((re) => re.test(m.text()))) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function fillLogin(page: Page, email: string, password = pwFor(email)): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('button[type="submit"]').click();
}

/** Logs in a dev user (no forced password change) and waits until the app loads. */
async function login(page: Page, email: string, password = pwFor(email)): Promise<void> {
  await fillLogin(page, email, password);
  await page.waitForURL('**/inbox');
}

test('1.4 #1: login page renders and toggles language vi↔en', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.goto('/login');
  await expect(page.locator('button[type="submit"]')).toHaveText('Đăng nhập');
  await page.screenshot({ path: 'e2e/__screenshots__/login-vi.png' });

  await page.getByText('EN', { exact: true }).click();
  await expect(page.locator('button[type="submit"]')).toHaveText('Sign in');

  expect(errors).toEqual([]);
});

test('1.4 #2: wrong credentials show a generic error, no console errors', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await fillLogin(page, 'member@dev.local', 'wrong-password');
  await expect(page.getByText('Email hoặc mật khẩu không đúng')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  expect(errors).toEqual([]);
});

test('1.8 #1: member sidebar omits admin/ssa items', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'member@dev.local');
  await expect(page).toHaveURL(/\/inbox/);
  // The sidebar is now a permanent icons-only rail (no expand toggle); each entry is a
  // menu item whose text content is its label. Assert membership via the item rows.
  const sider = page.locator('.ant-layout-sider');
  await expect(sider.locator('.ant-menu-item', { hasText: /^Hộp thư$/ })).toBeVisible(); // Inbox
  await expect(sider.locator('.ant-menu-item', { hasText: /^Cấu hình$/ })).toHaveCount(0); // Settings (admin)
  await expect(sider.locator('.ant-menu-item', { hasText: /^Quyền vai trò$/ })).toHaveCount(0); // Roles (ssa)
  expect(errors).toEqual([]);
});

test('1.8 #1: admin sidebar shows Settings but not SSA-only Roles', async ({ page }) => {
  await login(page, 'admin@dev.local');
  await expect(page).toHaveURL(/\/inbox/);
  // Permanent icons-only rail (no expand toggle) — assert via the menu item rows. The
  // `^…$` anchors keep "Cấu hình" (Settings) distinct from "Cấu hình nhắc/đính kèm".
  const sider = page.locator('.ant-layout-sider');
  await expect(sider.locator('.ant-menu-item', { hasText: /^Cấu hình$/ })).toBeVisible(); // Settings
  await expect(sider.locator('.ant-menu-item', { hasText: /^Quyền vai trò$/ })).toHaveCount(0); // Roles (ssa only)
});

test('1.8 #2: member hitting /admin/settings gets the 403 page', async ({ page }) => {
  await login(page, 'member@dev.local');
  await page.goto('/admin/settings');
  await expect(page.getByText('Không có quyền truy cập')).toBeVisible();
});

test('1.8 #3: SSA switches project via the header switcher', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'ssa@dev.local');
  await expect(page).toHaveURL(/\/inbox/);

  // SSA-only switcher present (members never see it). Scope by its aria-label so the
  // header's global search AutoComplete (Epic 10) doesn't make the locator ambiguous.
  const select = page.locator('.ant-layout-header .ant-select[aria-label="Dự án"]');
  await expect(select).toBeVisible();

  await select.click();
  await page.locator('.ant-select-item-option', { hasText: 'C&B' }).click();
  await expect(page.getByText(/Đã chuyển sang/)).toBeVisible(); // toast
  await expect(page).toHaveURL(/\/inbox/);
  expect(errors).toEqual([]);
});
