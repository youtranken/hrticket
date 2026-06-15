import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Story 9.5 (FR66–FR72) — Audit log + sensitive view-log viewer. Seeds (via psql) a
 * Payroll ticket with two audit rows + a view + a download, then verifies the admin
 * reader: the action log, an expandable old→new row, the view-log tab, and that a
 * Member is blocked (403). Scope/append-only/partition are proven by IT-AUDIT-002.
 * Needs SEED_DEV_USERS=true fixtures + the compose stack.
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const SHOTS = 'e2e/__screenshots__';
const STAMP = Date.now();
const CODE = `#A9${STAMP % 100000}`;
let ticketId = '';

function psql(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return execSync(`docker compose exec -T postgres psql -U hris -d hris -t -A -c "${oneLine}"`, { cwd: '../..' })
    .toString()
    .trim();
}

test.beforeAll(() => {
  ticketId = psql(
    `WITH ins AS (INSERT INTO tickets (project_id, ticket_code, subject, requester_email, mailbox, category_id, status, assignee_id) SELECT 1, '${CODE}', 'audit e2e ${STAMP}', 'req@x.com', 'hris@test.local', (SELECT id FROM categories WHERE project_id=1 AND name_en='Payroll'), 'in_progress', (SELECT id FROM users WHERE email='member@dev.local') RETURNING id) SELECT id FROM ins;`,
  );
  const attId = psql(
    `WITH ins AS (INSERT INTO attachments (ticket_id, file_name, mime_type, size, storage_path, status) VALUES ('${ticketId}', 'payslip-e2e.pdf', 'application/pdf', 10, 'a/b', 'stored') RETURNING id) SELECT id FROM ins;`,
  );
  const memberId = psql(`SELECT id FROM users WHERE email='member@dev.local';`);
  // Build jsonb via jsonb_build_object (single-quotes only) — literal '{"k":"v"}' would
  // have its inner double-quotes eaten by the surrounding shell `-c "..."`.
  psql(
    `INSERT INTO audit_log (project_id, actor_label, action, object_type, object_id, old_value, new_value)
     VALUES (1, 'admin@dev.local', 'ticket.created', 'ticket', '${ticketId}', NULL, jsonb_build_object('status','open')),
            (1, 'admin@dev.local', 'ticket.assigned', 'ticket', '${ticketId}', jsonb_build_object('assignee',NULL), jsonb_build_object('assignee','${memberId}'));`,
  );
  psql(
    `INSERT INTO view_log (actor_id, ticket_id, action) VALUES ('${memberId}', '${ticketId}', 'ticket_view');
     INSERT INTO view_log (actor_id, ticket_id, attachment_id, action) VALUES ('${memberId}', '${ticketId}', '${attId}', 'file_download');`,
  );
});

test.afterAll(() => {
  if (ticketId) {
    psql(
      `DELETE FROM view_log WHERE ticket_id='${ticketId}'; DELETE FROM audit_log WHERE object_id='${ticketId}'; DELETE FROM attachments WHERE ticket_id='${ticketId}'; DELETE FROM tickets WHERE id='${ticketId}';`,
    );
  }
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

test('9.5 audit viewer: admin reads the log + view-log; member is blocked', async ({ page }) => {
  expect(ticketId).toMatch(/[0-9a-f-]{36}/);
  const fatal = trackPageErrors(page);
  await login(page, 'admin@dev.local');

  await page.goto(`/audit?ticketId=${ticketId}`);
  await expect(page.locator('.ant-card-head-title')).toHaveText('Nhật ký', { timeout: 15000 });

  // Action log shows the two seeded rows for this ticket.
  const assignedRow = page.locator('.ant-table-row', { hasText: 'ticket.assigned' });
  await expect(assignedRow).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.ant-table-row', { hasText: 'ticket.created' })).toBeVisible();

  // Expand the assigned row → old→new diff is shown.
  await assignedRow.locator('.ant-table-row-expand-icon').click();
  await expect(page.locator('.ant-table-expanded-row')).toContainText('assignee');
  await page.screenshot({ path: `${SHOTS}/9.5-audit-log.png`, fullPage: true });

  // View-log tab → the file download row + filename.
  await page.getByRole('tab', { name: 'View-log nhạy cảm' }).click();
  await expect(page.locator('.ant-table-row', { hasText: 'payslip-e2e.pdf' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.ant-table-row', { hasText: 'Tải tệp' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/9.5-viewlog.png`, fullPage: true });

  // A Member cannot open the audit page (403).
  const memberCtx = await page.context().browser()!.newContext();
  const memberPage = await memberCtx.newPage();
  await login(memberPage, 'member@dev.local');
  await memberPage.goto('/audit');
  await expect(memberPage.locator('.ant-result-403')).toBeVisible({ timeout: 15000 });
  await memberCtx.close();

  expect(fatal, fatal.join('\n')).toEqual([]);
});
