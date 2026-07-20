import { execSync } from 'node:child_process';
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * FE-DT for the alert-detail + per-project scoping work: the notification bell must
 * show WHICH loop is down ("Cảnh báo hệ thống: Gửi mail (outbox)") and WHICH mailbox
 * failed ("Hộp thư C&B lỗi kết nối: …") — not a detail-free "Cảnh báo hệ thống" — and a
 * member must NOT see the admin/SSA-only system alerts. Runs against the live compose
 * stack with SEED_DEV_USERS=true fixtures (member/lead/admin/ssa @dev.local, all in hris).
 *
 * We seed the two notification rows straight into Postgres for admin@dev.local (a real
 * poll failure / stale heartbeat is not reproducible in a clean e2e run), then assert the
 * FE renders them. BE emission + scoping/dedup is covered by IT-OPS-008 in ops.it-spec.ts.
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const COMPOSE = process.env.E2E_COMPOSE ?? 'docker compose';

// Same console-noise filter the other specs use (AntD compat notice, router future flags,
// the browser's own "Failed to load resource" line for expected 4xx). Fail on anything else.
const IGNORED = [/\[antd: compatible\]/, /React Router Future Flag/, /Failed to load resource/];

const WORKER_ALERT_LABEL = 'Cảnh báo hệ thống: Gửi mail (outbox)';
const MAILBOX_DOWN_LABEL = 'Hộp thư C&B lỗi kết nối: Invalid credentials';

/** Run SQL in the compose Postgres via stdin (no shell-quoting of the JSON payload). */
function psql(sql: string): void {
  execSync(`${COMPOSE} exec -T postgres psql -U hris -d hris -v ON_ERROR_STOP=1`, {
    cwd: '../..',
    input: sql,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
}

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' && !IGNORED.some((re) => re.test(m.text()))) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/inbox');
}

async function openBell(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Thông báo' }).click();
  await expect(page.getByText('Thông báo', { exact: true })).toBeVisible(); // dropdown header
}

test.beforeAll(() => {
  // Two admin-scoped alerts for admin@dev.local (idempotent-ish: cleaned in afterAll).
  psql(`
    INSERT INTO notifications (actor_id, type, payload)
    SELECT id, 'worker_alert',
           '{"reason":"outbox=error","loops":["outbox"],"at":"2026-01-01T00:00:00.000Z"}'
      FROM users WHERE email = 'admin@dev.local';
    INSERT INTO notifications (actor_id, type, payload)
    SELECT id, 'mailbox_down',
           '{"projectId":2,"projectKey":"cnb","projectName":"C&B","error":"Invalid credentials"}'
      FROM users WHERE email = 'admin@dev.local';
  `);
});

test.afterAll(() => {
  psql(`
    DELETE FROM notifications
     WHERE type IN ('worker_alert','mailbox_down')
       AND actor_id = (SELECT id FROM users WHERE email = 'admin@dev.local');
  `);
});

test('NOTIF-1: admin bell shows WHICH loop is down and WHICH mailbox failed', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'admin@dev.local');
  await openBell(page);

  // The whole point of the fix: detail, not a bare "Cảnh báo hệ thống".
  await expect(page.getByText(WORKER_ALERT_LABEL)).toBeVisible();
  await expect(page.getByText(MAILBOX_DOWN_LABEL)).toBeVisible();

  await page.screenshot({ path: 'e2e/__screenshots__/notif-admin-alerts.png' });
  expect(errors).toEqual([]);
});

test('NOTIF-3: clicking a mailbox alert opens a detail popup with a shortcut to email settings', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'admin@dev.local');
  await openBell(page);
  await page.getByText(MAILBOX_DOWN_LABEL).click();

  // A popup (not a silent mark-read) with the specific error + what-to-do guidance.
  const dialog = page.locator('.ant-modal-confirm');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Kiểm tra lại App Password/)).toBeVisible();

  // The action button jumps to the email-connection page where the App Password is re-entered.
  await dialog.getByRole('button', { name: 'Đi tới Cấu hình email' }).click();
  await expect(page).toHaveURL(/\/admin\/email-connection/);
  expect(errors).toEqual([]);
});

test('NOTIF-2: a member never sees the admin/SSA-only system alerts', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'member@dev.local');
  await openBell(page);

  // Scoping: these rows were emitted to the admin only — the member's bell must not carry them.
  await expect(page.getByText(WORKER_ALERT_LABEL)).toHaveCount(0);
  await expect(page.getByText(MAILBOX_DOWN_LABEL)).toHaveCount(0);
  expect(errors).toEqual([]);
});
