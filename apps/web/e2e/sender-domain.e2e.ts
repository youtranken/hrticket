import { test, expect, type Page } from '@playwright/test';
import nodemailer from 'nodemailer';
import postgres from 'postgres';

/**
 * Story 4.7 (FR104) FE-DT — DOMAIN-PRIMARY routing, categories = companies. Driven end to
 * end through the real UI:
 *   1. Admin opens /admin/categories, creates a COMPANY category and adds a LIST of sender
 *      domains to it.
 *   2. A mail from one of those domains lands in that company pool.
 *   3. Domain beats keyword: even a mail carrying a work keyword ("luong") from the company
 *      domain still routes to the company (domain-primary), not the keyword category.
 * Requires the compose stack (greenmail :3025, POLL_INTERVAL_MS=5000) + SEED_DEV_USERS.
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://hris:hris@localhost:5432/hris';
const STAMP = Date.now();
const NAME_VI = 'Phú Hưng Thịnh';
const NAME_EN = `PHT-${STAMP}`;
// The company's list of sender domains (glob + a second domain + one exact address).
const DOMAINS = [`*@phth${STAMP}.com`, `*@phth${STAMP}.com.vn`];
const SENDER = `an@phth${STAMP}.com`;

const sql = postgres(DB_URL);
test.afterAll(async () => {
  const like = 'E2E SDR ' + STAMP + '%';
  await sql`DELETE FROM participants WHERE ticket_id IN (SELECT id FROM tickets WHERE subject LIKE ${like})`;
  await sql`DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE subject LIKE ${like})`;
  await sql`DELETE FROM ticket_tags WHERE ticket_id IN (SELECT id FROM tickets WHERE subject LIKE ${like})`;
  await sql`DELETE FROM outbox WHERE ticket_id IN (SELECT id FROM tickets WHERE subject LIKE ${like})`;
  await sql`DELETE FROM inbox_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE subject LIKE ${like})`;
  await sql`DELETE FROM tickets WHERE subject LIKE ${like}`;
  await sql`DELETE FROM category_sender_rules WHERE category_id IN (SELECT id FROM categories WHERE name_en = ${NAME_EN})`;
  await sql`DELETE FROM categories WHERE name_en = ${NAME_EN}`;
  await sql.end();
});

async function injectMail(subject: string, messageId: string, sender: string): Promise<void> {
  const t = nodemailer.createTransport({
    host: 'localhost',
    port: Number(process.env.E2E_SMTP_PORT ?? 3025),
    secure: false,
    tls: { rejectUnauthorized: false },
  });
  await t.sendMail({ from: sender, to: 'hris@test.local', subject, text: 'Body for SDR e2e.', messageId });
  t.close();
}

async function loginAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill('admin@dev.local');
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(inbox|admin)/);
}

/** Poll for the ticket the worker built from an injected mail; return its category name_en. */
async function categoryOf(subject: string): Promise<string> {
  let nameEn = '';
  await expect(async () => {
    const rows = await sql<{ name_en: string }[]>`
      SELECT c.name_en FROM tickets t JOIN categories c ON c.id = t.category_id
      WHERE t.subject = ${subject} LIMIT 1`;
    expect(rows.length).toBe(1);
    nameEn = rows[0]!.name_en;
  }).toPass({ timeout: 40_000 });
  return nameEn;
}

test('Story 4.7: admin creates a COMPANY category, adds its domain LIST, a mail routes in', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/admin/categories');

  // ── Open the "add category" drawer and name the COMPANY ──────────────────────────
  await page.getByRole('button', { name: /Thêm danh mục|Add category/ }).click();
  const drawer = page.locator('.ant-drawer-content');
  await expect(drawer).toBeVisible();
  await drawer.locator('input.ant-input').nth(0).fill(NAME_VI); // Vi = "Phú Hưng Thịnh"
  await drawer.locator('input.ant-input').nth(1).fill(NAME_EN); // En (unique key)

  // ── Add the LIST of sender domains (2nd tags-select; 1st is keywords) ─────────────
  const senderInput = drawer.locator('.ant-select-selection-search-input').nth(1);
  for (const d of DOMAINS) {
    await senderInput.fill(d);
    await senderInput.press('Enter');
    await expect(drawer.getByText(d, { exact: true })).toBeVisible();
  }

  await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click();
  await expect(drawer).toBeHidden();
  // The company row shows every domain chip in the "Sender domains" column.
  for (const d of DOMAINS) await expect(page.getByText(d, { exact: true })).toBeVisible();

  // ── A mail arrives from the company domain → routes into the company pool ─────────
  const subject = `E2E SDR ${STAMP} arrives`;
  await injectMail(subject, `<e2e-sdr-arrive-${STAMP}@x>`, SENDER);
  expect(await categoryOf(subject)).toBe(NAME_EN);
});

test('Story 4.7: DOMAIN beats keyword — a company mail with a work keyword still goes to the company', async ({ page }) => {
  await loginAdmin(page);
  // The company + its domains already exist from the previous test; if that was skipped,
  // create the rule directly so this test stands alone.
  const exists = await sql<{ id: number }[]>`SELECT id FROM categories WHERE name_en = ${NAME_EN} LIMIT 1`;
  if (exists.length === 0) {
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO categories (project_id, name_vi, name_en) VALUES (1, ${NAME_VI}, ${NAME_EN}) RETURNING id`;
    for (const d of DOMAINS) {
      await sql`INSERT INTO category_sender_rules (project_id, pattern, category_id) VALUES (1, ${d}, ${c!.id})`;
    }
  }

  // Subject carries the Payroll keyword "luong", but the sender is the company domain →
  // domain-primary wins → the company pool, NOT Payroll.
  const subject = `E2E SDR ${STAMP} luong`;
  await injectMail(subject, `<e2e-sdr-luong-${STAMP}@x>`, SENDER);
  const cat = await categoryOf(subject);
  expect(cat).toBe(NAME_EN);
  expect(cat).not.toBe('Payroll');
});
