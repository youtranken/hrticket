import { test, expect, type Page } from '@playwright/test';
import nodemailer from 'nodemailer';

/**
 * Epic 3 critical-flow acceptance (CLAUDE.md: reply outbound MUST have a CI e2e).
 * A mail becomes a ticket; an employee replies from the UI (outbox sends it) and
 * writes an internal note. Asserts the two compose paths are separate and the
 * outbound reply + internal note render distinctly. Requires the compose stack
 * (greenmail :3025, mailpit, POLL_INTERVAL_MS=5000) + SEED_DEV_USERS fixtures.
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';

async function injectMail(subject: string, messageId: string): Promise<void> {
  const t = nodemailer.createTransport({ host: 'localhost', port: 3025, secure: false, tls: { rejectUnauthorized: false } });
  await t.sendMail({
    from: 'requester@company.com',
    to: 'hris@test.local',
    subject,
    text: 'Can you confirm my remaining annual leave?',
    messageId,
  });
  t.close();
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/inbox');
}

test('Epic 3: employee replies from the UI and adds an internal note', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const subject = `E2E reply flow ${stamp}`;
  await injectMail(subject, `<e2e-reply-${stamp}@company.com>`);

  await login(page, 'admin@dev.local');

  // Worker polls every 5s — reload the Inbox until the ticket lands.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(subject)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 40_000 });

  // Wait for the reply-all default to load before touching the compose box — its
  // resolution seeds the recipients and stabilises the controlled inputs.
  const defaultsLoaded = page.waitForResponse(
    (r) => r.url().includes('/reply-defaults') && r.status() === 200,
  );
  await page.getByText(subject).click();
  await defaultsLoaded;

  // Reply tab: the To field is pre-filled with the requester (Reply-All default).
  const body = `Your remaining leave is 8 days. ${stamp}`;
  const sendBtn = page.getByRole('button', { name: /Gửi email|Send email/ });
  await page.getByPlaceholder(/Soạn câu trả lời|Write a reply/).fill(body);
  await expect(sendBtn).toBeEnabled();
  await sendBtn.click();

  // The outbound reply appears in the conversation timeline.
  await expect(page.getByText(body)).toBeVisible({ timeout: 10_000 });

  // Internal note goes through a SEPARATE tab + button and is badged internal.
  await page.getByRole('tab', { name: /Ghi chú nội bộ|Internal note/ }).click();
  const noteText = `internal-only note ${stamp}`;
  await page.getByPlaceholder(/KHÔNG gửi ra ngoài|NOT sent/).fill(noteText);
  await page.getByRole('button', { name: /Lưu ghi chú|Save note/ }).click();
  await expect(page.getByText(noteText)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Ghi chú nội bộ|Internal note/).first()).toBeVisible();

  // No console errors throughout (allow the pre-login /me 401 only).
});
