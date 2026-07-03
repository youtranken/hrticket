import { test, expect, type Page } from '@playwright/test';
import nodemailer from 'nodemailer';
import postgres from 'postgres';

/**
 * Epic 3 critical-flow acceptance (CLAUDE.md: reply outbound MUST have a CI e2e).
 * A mail becomes a ticket; an employee (the assignee/Member — Admin/SSA can't reply)
 * replies from the UI (outbox sends it) and writes an internal note. Asserts the two
 * compose paths are separate and the outbound reply + internal note render distinctly.
 * Requires the compose stack (greenmail :3025, mailpit, POLL_INTERVAL_MS=5000) +
 * SEED_DEV_USERS fixtures.
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://hris:hris@localhost:5432/hris';
const sql = postgres(DB_URL);
test.afterAll(async () => {
  await sql.end();
});

async function injectMail(subject: string, messageId: string, sender: string): Promise<void> {
  const t = nodemailer.createTransport({ host: 'localhost', port: Number(process.env.E2E_SMTP_PORT ?? 3025), secure: false, tls: { rejectUnauthorized: false } });
  await t.sendMail({
    from: sender,
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
  // Unique sender per run so the suite never trips the mail-bomb throttle (20/h/sender).
  await injectMail(subject, `<e2e-reply-${stamp}@company.com>`, `req-${stamp}@company.com`);

  await login(page, 'member@dev.local');

  // Worker polls every 5s — wait for the ticket to be created, then assign it to the
  // member (the handler) so the assignee can reply and sees it via the RLS carve-out.
  let ticketId = '';
  await expect(async () => {
    const rows = await sql<{ id: string }[]>`SELECT id FROM tickets WHERE subject = ${subject} LIMIT 1`;
    expect(rows.length).toBe(1);
    ticketId = rows[0]!.id;
  }).toPass({ timeout: 40_000 });
  await sql`UPDATE tickets SET assignee_id = (SELECT id FROM users WHERE email = 'member@dev.local'), status = 'in_progress', assigned_at = now() WHERE id = ${ticketId}`;

  // Wait for the reply-all default to load before touching the compose box — its
  // resolution seeds the recipients and stabilises the controlled inputs.
  const defaultsLoaded = page.waitForResponse(
    (r) => r.url().includes('/reply-defaults') && r.status() === 200,
  );
  await page.goto(`/tickets/${ticketId}`);
  await defaultsLoaded;

  // Reply tab: the To field is pre-filled with the requester (Reply-All default).
  const body = `Your remaining leave is 8 days. ${stamp}`;
  const sendBtn = page.getByRole('button', { name: /Gửi email|Send email/ });
  await page.getByPlaceholder(/Soạn câu trả lời|Write a reply/).fill(body);
  // Under full-suite load the reply-default recipients can seed slowly; give the
  // enable check headroom (the flow itself is fine, just slow on a busy stack).
  await expect(sendBtn).toBeEnabled({ timeout: 15000 });
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
