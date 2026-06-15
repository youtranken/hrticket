import { test, expect, request, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Story 11.2 (FR92) — complete i18n: the language switch is live (no reload),
 * reaches AntD internals (DatePicker locale), leaks no raw keys, and is persisted
 * per-account server-side so it follows the user to a fresh machine (AC3). Key
 * parity/usage + the no-literal-string lint rule guard coverage at build time
 * (i18n.spec.ts + eslint); this is the runtime proof. Needs the live compose stack.
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const SHOTS = 'e2e/__screenshots__';

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

// The language preference is account-scoped and persisted; restore it to vi so the
// other specs' Vietnamese-chrome assertions (e.g. auth.e2e) keep holding.
test.afterAll(async () => {
  const ctx = await request.newContext({ baseURL: BASE });
  try {
    await ctx.post('/api/auth/login', { data: { email: 'admin@dev.local', password: DEV_PW } });
    await ctx.patch('/api/me/language', { data: { language: 'vi' } });
  } finally {
    await ctx.dispose();
  }
});

test('11.2: language switch is live, persisted server-side, and reaches AntD internals', async ({
  page,
  browser,
}) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'admin@dev.local');
  const sider = page.locator('.ant-layout-sider');

  // Default Vietnamese chrome.
  await expect(sider.getByText('Hộp thư', { exact: true })).toBeVisible({ timeout: 15000 });

  // Live switch to EN — no reload (i18next).
  await page.locator('.ant-segmented').getByText('EN', { exact: true }).click();
  await expect(sider.getByText('Inbox', { exact: true })).toBeVisible();
  await expect(sider.getByText('Hộp thư', { exact: true })).toHaveCount(0);
  await expect(sider.getByText('Email connection')).toBeVisible();
  await expect(sider.getByText('Settings', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/11.2-en-sidebar.png`, fullPage: true });

  // No raw i18n key (e.g. "menu.inbox") leaks into the rendered chrome.
  expect(await sider.innerText()).not.toMatch(/[a-z]+(\.[a-z]+){2,}/);

  // AntD internals follow the locale. The app deliberately uses native date inputs
  // (no dayjs/AntD DatePicker), so the clearest proxy is the Table pagination — its
  // next-page control's title is enUS "Next Page" (viVN would be "Trang Kế…").
  await page.goto('/inbox');
  const nextPage = page.locator('.ant-pagination-next');
  await expect(nextPage).toBeVisible({ timeout: 10000 });
  await expect(nextPage).toHaveAttribute('title', /Next/i);
  await page.screenshot({ path: `${SHOTS}/11.2-pagination-en.png`, fullPage: true });

  // AC3 — a FRESH context (no localStorage) logs in and gets EN from the account.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await login(page2, 'admin@dev.local');
  const sider2 = page2.locator('.ant-layout-sider');
  await expect(sider2.getByText('Inbox', { exact: true })).toBeVisible();
  await expect(sider2.getByText('Hộp thư', { exact: true })).toHaveCount(0);
  await ctx2.close();

  expect(errors).toEqual([]);
});
