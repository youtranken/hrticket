import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Story 9.3 (FR60/NFR5) — the sensitive 🛡 badge on the worklist + detail, for a user
 * who is in scope (a Payroll member seeing their own Payroll ticket). The keep-WIP RLS
 * + endpoint sweep are proven exhaustively by IT-VIS-001/002; this is the visual proof.
 * Seeds one in-progress Payroll ticket assigned to member@dev.local via psql, then cleans
 * it up. Needs SEED_DEV_USERS=true fixtures + the compose stack.
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const SHOTS = 'e2e/__screenshots__';
const SUBJECT = `e2e sensitive payroll ${Date.now()}`;
const CODE = `#E93${Date.now() % 100000}`;
let ticketId = '';

function psql(sql: string): string {
  // Single-line SQL only — newlines break the `-c` argument through the shell.
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return execSync(`docker compose exec -T postgres psql -U hris -d hris -t -A -c "${oneLine}"`, {
    cwd: '../..',
  })
    .toString()
    .trim();
}

test.beforeAll(() => {
  // CTE-wrap so only the id row prints (a bare INSERT…RETURNING also emits "INSERT 0 1").
  ticketId = psql(
    `WITH ins AS (INSERT INTO tickets (project_id, ticket_code, subject, requester_email, mailbox, category_id, status, assignee_id) SELECT 1, '${CODE}', '${SUBJECT}', 'req@x.com', 'hris@test.local', (SELECT id FROM categories WHERE project_id=1 AND name_en='Payroll'), 'in_progress', (SELECT id FROM users WHERE email='member@dev.local') RETURNING id) SELECT id FROM ins;`,
  );
});

test.afterAll(() => {
  if (ticketId) psql(`DELETE FROM view_log WHERE ticket_id='${ticketId}'; DELETE FROM tickets WHERE id='${ticketId}';`);
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/(inbox|my-tickets|pool)/, { timeout: 15000 });
}

function trackPageErrors(page: Page): string[] {
  const fatal: string[] = [];
  page.on('pageerror', (e) => fatal.push(`pageerror: ${e.message}`));
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') console.log(`[console.error] ${m.text()}`);
  });
  return fatal;
}

test('9.3 sensitive badge: in-scope member sees 🛡 on worklist + detail', async ({ page }) => {
  expect(ticketId, 'seed ticket id').toMatch(/[0-9a-f-]{36}/);
  const fatal = trackPageErrors(page);
  await login(page, 'member@dev.local');

  // Worklist ("My tickets") — the assigned sensitive ticket carries the 🛡 badge.
  await page.goto('/my-tickets');
  const row = page.locator('.ant-table-row', { hasText: SUBJECT });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row).toContainText('🛡');
  await page.screenshot({ path: `${SHOTS}/9.3-sensitive-list.png`, fullPage: true });

  // Detail — the 🛡 "Nhạy cảm" badge sits in the header.
  await page.goto(`/tickets/${ticketId}`);
  await expect(page.locator('.ant-tag', { hasText: 'Nhạy cảm' })).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/9.3-sensitive-detail.png`, fullPage: true });

  expect(fatal, fatal.join('\n')).toEqual([]);
});
