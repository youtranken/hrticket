import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Đơn 13 — report access per role. IT-REPORT-003/004 prove the numbers (member
 * pinned to self, week/year buckets) at the service+RLS layer; this is the
 * committed FE proof that (a) a MEMBER now reaches /reports and gets a self
 * report with no staff comparison/filter, and (b) an ADMIN gets the staff
 * filter + week/month/year granularity. Needs SEED_DEV_USERS fixtures + stack.
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const SHOTS = 'e2e/__screenshots__';
const SUBJECT = `e2e report seed ${Date.now()}`;
let memberTicket = '';

function psql(sql: string): string {
  // Single-line SQL only — newlines break the `-c` argument through the shell.
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return execSync(`${process.env.E2E_COMPOSE ?? 'docker compose'} exec -T postgres psql -U hris -d hris -t -A -c "${oneLine}"`, {
    cwd: '../..',
  })
    .toString()
    .trim();
}

test.beforeAll(() => {
  // One Payroll ticket assigned to the member so (a) their self report is
  // non-empty and (b) they appear in the admin's staff-filter options.
  memberTicket = psql(
    `WITH ins AS (INSERT INTO tickets (project_id, ticket_code, subject, requester_email, mailbox, category_id, status, assignee_id, assigned_at) SELECT 1, '#E13${Date.now() % 100000}', '${SUBJECT}', 'req@x.com', 'hris@test.local', (SELECT id FROM categories WHERE project_id=1 AND name_en='Payroll'), 'in_progress', (SELECT id FROM users WHERE email='member@dev.local'), now() RETURNING id) SELECT id FROM ins;`,
  );
});

test.afterAll(() => {
  if (memberTicket) {
    psql(`DELETE FROM view_log WHERE ticket_id='${memberTicket}'; DELETE FROM tickets WHERE id='${memberTicket}';`);
  }
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  // 45s (not the usual 15s): argon2 login verify crawls when the host runs several
  // compose stacks at once — seen live at ~13s per login on a loaded machine.
  await expect(page).toHaveURL(/\/(inbox|my-tickets|pool)/, { timeout: 45000 });
}

function trackPageErrors(page: Page): string[] {
  const fatal: string[] = [];
  page.on('pageerror', (e) => fatal.push(`pageerror: ${e.message}`));
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') console.log(`[console.error] ${m.text()}`);
  });
  return fatal;
}

test('đơn 13 / v2: member reaches /reports as a SELF report — no staff card, no user filter', async ({ page }) => {
  expect(memberTicket, 'seed ticket id').toMatch(/[0-9a-f-]{36}/);
  const fatal = trackPageErrors(page);
  await login(page, 'member@dev.local');

  // The sidebar now offers Reports to a member (previously hidden + 403). The
  // sidebar is an icons-only rail (no text labels) — target the chart icon.
  await page.locator('li.ant-menu-item', { has: page.locator('[data-icon="bar-chart"]') }).click();
  await expect(page).toHaveURL(/\/reports/);
  await expect(page.getByText('Ticket theo thời gian')).toBeVisible({ timeout: 15000 });

  // v2 KPI header renders (the 4 cards) and the self numbers are non-empty:
  // the by-category stacked bars list Payroll (the seeded ticket's pool).
  await expect(page.getByText('Tổng ticket đã xử lý')).toBeVisible({ timeout: 15000 });
  const catCard = page.locator('.ant-card', { hasText: 'Theo danh mục' });
  await expect(catCard.getByText('Lương', { exact: true })).toBeVisible({ timeout: 15000 });

  // Member never gets the cross-staff scoreboard nor the user filter.
  await expect(page.getByText('Hiệu suất nhân viên')).toHaveCount(0);
  await expect(page.locator('.ant-select-selection-placeholder', { hasText: 'Tất cả nhân viên' })).toHaveCount(0);

  await page.screenshot({ path: `${SHOTS}/13-report-member-self.png`, fullPage: true });
  expect(fatal, fatal.join('\n')).toEqual([]);
});

test('đơn 13 / v2: admin gets year picker, week/month/year buckets + a per-user filter', async ({ page }) => {
  const fatal = trackPageErrors(page);
  await login(page, 'admin@dev.local');
  await page.goto('/reports');

  // Full view: the staff scoreboard (v2) is there for the admin, with the dev
  // member (who holds the seeded ticket) as a clickable row.
  await expect(page.getByText('Hiệu suất nhân viên')).toBeVisible({ timeout: 15000 });
  const staffCard = page.locator('.ant-card', { hasText: 'Hiệu suất nhân viên' });
  await expect(staffCard.locator('.ant-table-row', { hasText: 'Dev Member' })).toBeVisible({ timeout: 15000 });

  // Switch the trend bucket to WEEK and open the number table — header + labels follow.
  const timeCard = page.locator('.ant-card', { hasText: 'Ticket theo thời gian' });
  await timeCard.locator('.ant-segmented-item', { hasText: 'Tuần' }).click();
  await timeCard.getByRole('button', { name: 'Xem bảng' }).click();
  await expect(timeCard.locator('th', { hasText: 'Tuần' })).toBeVisible({ timeout: 15000 });
  await expect(timeCard.locator('.ant-table-tbody td').first()).toHaveText(/^\d{4}-W\d{2}$/);

  // ...and to YEAR granularity.
  await timeCard.locator('.ant-segmented-item', { hasText: 'Năm' }).click();
  await expect(timeCard.locator('.ant-table-tbody td').first()).toHaveText(/^\d{4}$/, { timeout: 15000 });

  // Slice everything to one staff member via the filter; the member's Payroll
  // ticket keeps the sliced by-category bars non-empty.
  await page.locator('.ant-select', { hasText: 'Tất cả nhân viên' }).click();
  await page.locator('.ant-select-item-option', { hasText: 'Dev Member' }).first().click();
  const catCard = page.locator('.ant-card', { hasText: 'Theo danh mục' });
  await expect(catCard.getByText('Lương', { exact: true })).toBeVisible({ timeout: 15000 });

  await page.screenshot({ path: `${SHOTS}/13-report-admin-filter.png`, fullPage: true });
  expect(fatal, fatal.join('\n')).toEqual([]);
});
