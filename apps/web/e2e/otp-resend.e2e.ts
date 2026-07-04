import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * FE-DT — OTP login + resend (UX P0 #11). Critical auth flow, committed for CI.
 * Full cycle against the live compose stack: enable 2FA in the profile, log back
 * in through the OTP screen, wait out the 60s resend cooldown, resend, sign in
 * with the FRESH code (proving the new pre-auth token + code pair works), then
 * disable 2FA again so the shared dev user stays clean for other suites.
 *
 * Codes are read from Mailpit (:8025) — OTP mail goes out via direct SMTP.
 * NOTE: each run issues ~2-3 codes; the BE caps 5 codes/15min per user, so two
 * back-to-back runs inside one window can 429 — rerun after the window if so.
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';
const EMAIL = 'lead@dev.local';

const IGNORED = [/\[antd: compatible\]/, /React Router Future Flag/, /Failed to load resource/];

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' && !IGNORED.some((re) => re.test(m.text()))) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

interface MailpitMessage {
  ID: string;
  To?: { Address: string }[];
}

/** Latest Mailpit message id addressed to `rcpt` (Mailpit lists newest first). */
async function latestMailIdTo(rcpt: string): Promise<string | undefined> {
  const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages.find((m) => (m.To ?? []).some((a) => a.Address === rcpt))?.ID;
}

/** Poll for an OTP mail to `rcpt` NEWER than `afterId`; extract the 6-digit code. */
async function otpCodeFor(rcpt: string, afterId?: string): Promise<{ id: string; code: string }> {
  for (let i = 0; i < 30; i += 1) {
    const id = await latestMailIdTo(rcpt);
    if (id && id !== afterId) {
      const res = await fetch(`${MAILPIT}/api/v1/message/${id}`);
      const body = (await res.json()) as { HTML?: string; Text?: string };
      const m = (body.Text ?? body.HTML ?? '').match(/\b(\d{6})\b/);
      if (m) return { id, code: m[1]! };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no OTP mail for ${rcpt} (after ${afterId ?? 'none'})`);
}

async function fillLogin(page: Page, email: string, password = DEV_PW): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('button[type="submit"]').click();
}

/** Flip the profile 2FA switch (either direction) and confirm with the password. */
async function toggleOtpInProfile(page: Page): Promise<void> {
  // Header avatar dropdown → "Hồ sơ" opens the profile modal (no route change).
  await page.locator('.ant-layout-header .ant-avatar').click();
  await page.getByText('Hồ sơ', { exact: true }).click();
  const modal = page.locator('.ant-modal-content').filter({ hasText: 'Xác thực 2 lớp (OTP)' });
  await modal.getByRole('switch').click();
  // Password-confirm modal stacks on top of the profile modal.
  const confirm = page.locator('.ant-modal-content').filter({ hasText: 'Xác nhận mật khẩu' });
  await confirm.locator('input[type="password"]').fill(DEV_PW);
  await confirm.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('Đã lưu').first()).toBeVisible();
  await page.keyboard.press('Escape'); // close the profile modal
}

test('OTP resend: cooldown → fresh code signs in; 2FA restored off afterwards', async ({ page }) => {
  test.setTimeout(300_000); // includes the real 60s resend cooldown
  const errors = trackConsoleErrors(page);

  // 1) Plain login and turn 2FA ON.
  await fillLogin(page, EMAIL);
  await page.waitForURL('**/inbox');
  await toggleOtpInProfile(page);

  try {
    // 2) Fresh session → the password step now lands on the OTP screen.
    await page.context().clearCookies();
    const before = await latestMailIdTo(EMAIL);
    await fillLogin(page, EMAIL);
    await expect(page.getByText('Xác thực OTP')).toBeVisible();

    // Resend starts DISABLED behind a live countdown.
    const counting = page.getByRole('button', { name: /Gửi lại mã sau \d+s/ });
    await expect(counting).toBeVisible();
    await expect(counting).toBeDisabled();
    const first = await otpCodeFor(EMAIL, before); // code #1 (login) delivered

    // 3) Cooldown elapses → resend → a NEW code lands in Mailpit.
    const resend = page.getByRole('button', { name: 'Gửi lại mã', exact: true });
    await expect(resend).toBeEnabled({ timeout: 70_000 });
    await resend.click();
    await expect(page.getByText('Đã gửi lại mã mới — kiểm tra hộp thư')).toBeVisible();
    const second = await otpCodeFor(EMAIL, first.id);
    expect(second.code).not.toBe(first.code);

    // 4) The FRESH code + the FRESH pre-auth token sign in. Input.OTP renders 6
    //    boxes with auto-advance — type into the first, the rest follow.
    await page.locator('.ant-otp input').first().click();
    await page.keyboard.type(second.code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await page.waitForURL('**/inbox');
  } finally {
    // 5) ALWAYS try to turn 2FA back OFF — other suites log in as this user.
    if (!page.url().includes('/inbox')) {
      // Best-effort recovery: password step, then whatever code is newest.
      await fillLogin(page, EMAIL).catch(() => undefined);
      const heading = page.getByText('Xác thực OTP');
      if (await heading.isVisible().catch(() => false)) {
        const latest = await otpCodeFor(EMAIL).catch(() => undefined);
        if (latest) {
          await page.locator('.ant-otp input').first().click();
          await page.keyboard.type(latest.code);
          await page.getByRole('button', { name: 'Xác nhận' }).click();
          await page.waitForURL('**/inbox').catch(() => undefined);
        }
      }
    }
    if (page.url().includes('/inbox')) await toggleOtpInProfile(page);
  }

  expect(errors).toEqual([]);
});
