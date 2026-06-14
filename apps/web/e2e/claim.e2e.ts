import { test, expect, type Page } from '@playwright/test';
import nodemailer from 'nodemailer';

/**
 * Epic 4 critical-flow acceptance (CLAUDE.md: assignment/visibility MUST have a CI
 * e2e). A "nghỉ phép" mail classifies to Leave (which has no auto-assign config in
 * the dev seed) → it lands in the group Pool. A member claims it (it moves to "My
 * tickets"), an admin assigns one manually, and two users racing for the same pool
 * ticket end with exactly one winner. Requires the compose stack (greenmail :3025,
 * POLL_INTERVAL_MS=5000) + SEED_DEV_USERS (member/lead in the Leave group).
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const CLAIM = /Nhận$|Claim$/;

// Worker polls every 5s; logging in + injecting + waiting for intake needs > the
// default 30s test cap, so give each test a generous budget.
test.describe.configure({ timeout: 120_000 });

async function injectLeaveMail(subject: string, messageId: string): Promise<void> {
  const t = nodemailer.createTransport({ host: 'localhost', port: 3025, secure: false, tls: { rejectUnauthorized: false } });
  // Subject is ASCII on purpose: classify is accent-insensitive (f_unaccent), so
  // "nghi phep" still routes to Leave, while an ASCII subject survives the MIME
  // round-trip unchanged so getByText matches (diacritics get NFC/NFD-normalised).
  await t.sendMail({ from: 'requester@company.com', to: 'hris@test.local', subject, text: 'Hoi ve nghi phep.', messageId });
  t.close();
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/inbox');
}

/** Inject a Leave mail and wait until it surfaces in the given page's Pool view. */
async function poolTicket(page: Page, tag: string): Promise<string> {
  const stamp = `${Date.now()}-${tag}`;
  const subject = `E2E nghi phep ${stamp}`;
  await injectLeaveMail(subject, `<e2e-claim-${stamp}@company.com>`);
  await page.goto('/pool');
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(subject)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 45_000 });
  return subject;
}

test('Epic 4.4: a member claims a pooled ticket; it moves to My tickets', async ({ page }) => {
  await login(page, 'member@dev.local');
  const subject = await poolTicket(page, 'claim');

  const row = page.getByRole('row', { name: new RegExp(subject) });
  await row.getByRole('button', { name: CLAIM }).click();
  await expect(page.getByText(/Đã nhận ticket|Ticket claimed/)).toBeVisible({ timeout: 10_000 });

  // It left the pool and now shows under "Ticket của tôi".
  await page.goto('/my-tickets');
  await expect(page.getByText(subject)).toBeVisible({ timeout: 10_000 });
});

test('Epic 4.5: an admin assigns a pooled ticket via "Gán cho…"', async ({ page }) => {
  await login(page, 'admin@dev.local');
  const subject = await poolTicket(page, 'assign');

  await page.getByText(subject).click();
  await page.waitForURL('**/tickets/**');
  await page.getByRole('button', { name: /Gán cho|Assign to/ }).click();

  // Pick a group member (the dev Team Lead) and confirm.
  await page.locator('.ant-modal .ant-select-selector').click();
  await page.getByText(/Dev Team Lead/).click();
  await page.getByRole('button', { name: /^OK$/ }).click();
  await expect(page.getByText(/Đã gán người xử lý|Assignee set/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Dev Team Lead').first()).toBeVisible();
});

test('Epic 4.4 AC1: two users racing to claim → exactly one winner', async ({ browser }) => {
  const stamp = `${Date.now()}-race`;
  const subject = `E2E nghi phep ${stamp}`;
  await injectLeaveMail(subject, `<e2e-claim-${stamp}@company.com>`);

  const ctxs = await Promise.all([browser.newContext(), browser.newContext()]);
  const [p1, p2] = await Promise.all(ctxs.map((c) => c.newPage()));
  await login(p1, 'member@dev.local');
  await login(p2, 'lead@dev.local');

  const waitInPool = async (p: Page) => {
    await p.goto('/pool');
    await expect(async () => {
      await p.reload();
      await expect(p.getByText(subject)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 45_000 });
  };
  await Promise.all([waitInPool(p1), waitInPool(p2)]);

  // Both click "Nhận"; capture each claim POST's status. AC1 is literally "exactly
  // one becomes assignee, the other gets 409" — assert that on the responses (the
  // deterministic signal; cross-context list re-renders are racy under load).
  const claimStatus = async (p: Page): Promise<number> => {
    const respP = p.waitForResponse((r) => r.url().includes('/claim'));
    await p.getByRole('row', { name: new RegExp(subject) }).getByRole('button', { name: CLAIM }).click();
    return (await respP).status();
  };
  const statuses = await Promise.all([claimStatus(p1), claimStatus(p2)]);
  expect(statuses.filter((s) => s >= 200 && s < 300)).toHaveLength(1); // one winner
  expect(statuses.filter((s) => s === 409)).toHaveLength(1); // one "already claimed"

  await Promise.all(ctxs.map((c) => c.close()));
});
