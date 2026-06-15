import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Story 11.1 (FR90) — Email connection config + real "Test connection". Runs
 * against the live compose stack: the api reaches `greenmail:3143` (IMAP) and
 * `mailpit:1025` (SMTP) by service name, so a server-side test login is real and
 * deterministic. The test uses the SUBMITTED form values (never saves), so the
 * live worker's config is untouched. Persistence / crypto / DB-over-env precedence
 * are proven by IT-CONN-001..004; this covers the SSA UI + the real two-way test
 * + independent partial failure.
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
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

async function fillPort(page: Page, hostAria: string, value: string): Promise<void> {
  const card = page.locator('.ant-card').filter({ has: page.locator(`input[aria-label="${hostAria}"]`) });
  const num = card.locator('.ant-input-number-input');
  await num.fill(value);
  await num.blur();
}

test('11.1: SSA fills the connection, tests it live, and reads partial failure', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'ssa@dev.local');

  await page.goto('/admin/email-connection');
  await expect(page.locator('.ant-card-head-title').first()).toBeVisible({ timeout: 15000 });

  // The App Password field is an obscured (write-only) password input.
  await expect(page.locator('input[aria-label="app-password"]')).toHaveAttribute('type', 'password');
  await page.screenshot({ path: `${SHOTS}/11.1-connection-form.png`, fullPage: true });

  // Enter the (server-reachable) GreenMail + Mailpit coordinates.
  await page.locator('input[aria-label="imap-host"]').fill('greenmail');
  await page.locator('input[aria-label="imap-user"]').fill('hris@test.local');
  await fillPort(page, 'imap-host', '3143');
  await page.locator('input[aria-label="smtp-host"]').fill('mailpit');
  await page.locator('input[aria-label="smtp-user"]').fill('hris@test.local');
  await fillPort(page, 'smtp-host', '1025');
  await page.locator('input[aria-label="app-password"]').fill('test');

  // Test connection → both legs succeed.
  await page.getByRole('button', { name: 'Test kết nối' }).click();
  const result = page.locator('[aria-label="test-result"]');
  await expect(result).toBeVisible({ timeout: 15000 });
  await expect(result.getByText('✅ IMAP')).toBeVisible();
  await expect(result.getByText('✅ SMTP')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/11.1-test-ok.png`, fullPage: true });

  // Break only the SMTP host → IMAP stays ✅ while SMTP turns ❌ (independent legs).
  await page.locator('input[aria-label="smtp-host"]').fill('nonexistent.invalid');
  await page.getByRole('button', { name: 'Test kết nối' }).click();
  await expect(result.getByText('❌ SMTP')).toBeVisible({ timeout: 15000 });
  await expect(result.getByText('✅ IMAP')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/11.1-test-partial.png`, fullPage: true });

  expect(errors).toEqual([]);
});
