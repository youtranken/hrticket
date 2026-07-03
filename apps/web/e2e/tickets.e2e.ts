import { test, expect, type Page } from '@playwright/test';
import nodemailer from 'nodemailer';

/**
 * Epic 2 visual acceptance: a real mail injected into GreenMail is polled by the
 * worker, becomes a ticket, and renders in the Inbox + detail (with attachment
 * states). Requires the compose stack (greenmail on :3025, POLL_INTERVAL_MS=5000)
 * and SEED_DEV_USERS fixtures.
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 0x20)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(32, 0)]);

async function injectMail(subject: string, messageId: string, sender: string): Promise<void> {
  const t = nodemailer.createTransport({ host: 'localhost', port: Number(process.env.E2E_SMTP_PORT ?? 3025), secure: false, tls: { rejectUnauthorized: false } });
  await t.sendMail({
    from: sender,
    to: 'hris@test.local',
    cc: 'colleague@company.com',
    subject,
    text: 'Please advise on annual leave policy.',
    messageId,
    attachments: [
      { filename: 'policy.pdf', content: PDF },
      { filename: 'macro.exe', content: EXE },
    ],
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

test('Epic 2: injected mail becomes a ticket and renders with attachment states', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const subject = `E2E leave question ${stamp}`;
  // Unique sender per run so the mail-bomb throttle (20/h per sender) never trips
  // when the whole suite injects many mails in one hour.
  const sender = `emp-${stamp}@company.com`;
  await injectMail(subject, `<e2e-${stamp}@company.com>`, sender);

  await login(page, 'admin@dev.local'); // admin sees the whole hris project

  // Sort newest-first so the just-created pool ticket sits on page 1 regardless of how
  // many tickets the shared dev stack has accumulated (pool sinks in worklist order).
  await page.goto('/inbox?sort=created&dir=desc');

  // The worker polls every 5s — reload the Inbox until the new ticket appears.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(subject)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 40_000 });

  // Open the ticket and verify the conversation + attachment handling.
  await page.getByText(subject).click();
  await expect(page.getByText('Please advise on annual leave policy.')).toBeVisible();
  await expect(page.getByText(/policy\.pdf/)).toBeVisible(); // stored
  await expect(page.getByText(/macro\.exe/)).toBeVisible(); // blocked card
  await expect(page.getByText(sender).first()).toBeVisible(); // requester
});
