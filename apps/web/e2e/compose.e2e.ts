import { test, expect, type Page } from '@playwright/test';
import nodemailer from 'nodemailer';
import postgres from 'postgres';

/**
 * Epic 3 FE-DT scenarios beyond the core reply flow (reply.e2e.ts):
 *   - draft autosave survives a full reload (3.5)
 *   - attachment upload: valid file accepted, .exe rejected client-side (3.6)
 *   - confirm modal when a new recipient is added (3.2/3.4)
 *   - sensitive-category reply forces the confirm modal even with default recipients (3.4 AC3)
 * Requires the compose stack (greenmail :3025, POLL_INTERVAL_MS=5000) + SEED_DEV_USERS,
 * and direct DB access to flip a ticket's category to a sensitive one (classification
 * is Epic 4; until then intake routes everything to "Khác").
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://hris:hris@localhost:5432/hris';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);

const sql = postgres(DB_URL);
test.afterAll(async () => {
  await sql.end();
});

async function injectMail(subject: string, messageId: string): Promise<void> {
  const t = nodemailer.createTransport({ host: 'localhost', port: 3025, secure: false, tls: { rejectUnauthorized: false } });
  await t.sendMail({ from: 'requester@company.com', to: 'hris@test.local', subject, text: 'Body for compose e2e.', messageId });
  t.close();
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill('admin@dev.local');
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/inbox');
}

/** Inject a mail, wait for the worker to make a ticket, open it. Returns the ticket id. */
async function openFreshTicket(page: Page, tag: string): Promise<string> {
  const stamp = `${Date.now()}-${tag}`;
  const subject = `E2E compose ${stamp}`;
  await injectMail(subject, `<e2e-compose-${stamp}@company.com>`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(subject)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 40_000 });
  const defaultsLoaded = page.waitForResponse((r) => r.url().includes('/reply-defaults') && r.status() === 200);
  await page.getByText(subject).click();
  await defaultsLoaded;
  return page.url().split('/tickets/')[1]!;
}

test('Epic 3.5: a reply draft autosaves and survives a reload', async ({ page }) => {
  await login(page);
  await openFreshTicket(page, 'draft');

  const body = `draft that must survive F5 ${Date.now()}`;
  const savePut = page.waitForResponse((r) => r.url().includes('/draft') && r.request().method() === 'PUT' && r.status() === 200);
  await page.getByPlaceholder(/Soạn câu trả lời|Write a reply/).fill(body);
  await savePut; // debounced autosave fired

  await page.reload();
  // Draft restored into the compose box + the "saved at" label is shown.
  await expect(page.getByPlaceholder(/Soạn câu trả lời|Write a reply/)).toHaveValue(body);
  await expect(page.getByText(/Bản nháp lưu lúc|Draft saved at/)).toBeVisible();
});

test('Epic 3.6: valid attachment is accepted, .exe is rejected client-side', async ({ page }) => {
  await login(page);
  await openFreshTicket(page, 'upload');

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({ name: 'payslip.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(page.getByText(/payslip\.pdf/)).toBeVisible({ timeout: 10_000 }); // chip rendered

  // .exe never even uploads (blocked before any network request) → error toast, no chip.
  await fileInput.setInputFiles({ name: 'malware.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ\x90\x00') });
  await expect(page.getByText(/không hợp lệ|Invalid file/)).toBeVisible();
  await expect(page.getByText(/malware\.exe/)).toHaveCount(0);
});

test('Epic 3.2: adding a new recipient forces a confirm modal; cancel does not send', async ({ page }) => {
  await login(page);
  await openFreshTicket(page, 'confirm');

  await page.getByPlaceholder(/Soạn câu trả lời|Write a reply/).fill('looping in a colleague');
  // Add a stranger to CC (second tags combobox).
  const ccBox = page.locator('.ant-select-selector').nth(1).locator('input');
  await ccBox.fill('stranger@external.com');
  await ccBox.press('Enter');

  await page.getByRole('button', { name: /Gửi email|Send email/ }).click();
  const dialog = page.getByRole('dialog', { name: /Xác nhận người nhận|Confirm recipients/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('stranger@external.com')).toBeVisible();

  // Cancel → nothing is sent (no /replies request leaves).
  let replyFired = false;
  page.on('request', (r) => { if (r.url().includes('/replies')) replyFired = true; });
  await dialog.getByRole('button', { name: /Hủy|Cancel/ }).click();
  await expect(dialog).toBeHidden();
  expect(replyFired).toBe(false);
});

test('Epic 3.4 AC3: a sensitive ticket forces the confirm modal even with default recipients', async ({ page }) => {
  await login(page);
  const ticketId = await openFreshTicket(page, 'sensitive');
  // Promote the ticket into a sensitive category (Payroll) — pre-Epic-4 setup.
  await sql`
    UPDATE tickets SET category_id = (
      SELECT id FROM categories WHERE project_id = 1 AND is_sensitive = true ORDER BY id LIMIT 1
    ) WHERE id = ${ticketId}`;
  await page.reload();
  await page.waitForResponse((r) => r.url().includes('/reply-defaults') && r.status() === 200);

  // Send with the DEFAULT recipients (unchanged) — must still confirm, with the warning.
  await page.getByPlaceholder(/Soạn câu trả lời|Write a reply/).fill('sensitive answer');
  await page.getByRole('button', { name: /Gửi email|Send email/ }).click();
  const dialog = page.getByRole('dialog', { name: /Xác nhận người nhận|Confirm recipients/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/NHẠY CẢM|SENSITIVE/)).toBeVisible();
});
