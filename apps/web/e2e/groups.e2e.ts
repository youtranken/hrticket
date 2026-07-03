import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Story 9.1 (FR57/FR58/FR61) — category-group membership admin, a permission/visibility
 * CRITICAL flow → committed e2e (CLAUDE.md). Drives the real Transfer list end-to-end:
 * admin grants "Dev Member" into a 0-member group, the count updates, then restores it
 * so the run is idempotent. RLS-level visibility is proven by IT-GROUP-001/002.
 * Needs SEED_DEV_USERS=true fixtures (admin@dev.local / dev-password-123).
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const SHOTS = 'e2e/__screenshots__';
const GROUP = 'Chấm công'; // Attendance — no dev members in the seed (count starts at 0)
const MEMBER = 'Dev Member';

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

/** Dual-pane membership editor: tick the available row (left) then click the → arrow to
 *  move it into "Trong nhóm" (right). Removal is the ✕ on the in-group row. */
const availRow = (page: Page) => page.locator('.group-row:not(.group-row--drag)', { hasText: MEMBER });
const inGroupRow = (page: Page) => page.locator('.group-row--drag', { hasText: MEMBER });

test('9.1 group membership: admin grants a member into a group via the dual-pane list', async ({ page }) => {
  const fatal = trackPageErrors(page);
  await login(page, 'admin@dev.local');

  await page.goto('/admin/groups');
  // AntD Card title is a div, not an ARIA heading — assert via the card head + tabs.
  await expect(page.locator('.ant-card-head-title')).toHaveText('Nhóm & Quyền', { timeout: 15000 });
  // Both directions are present.
  await expect(page.getByRole('tab', { name: 'Theo nhóm' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Theo người dùng' })).toBeVisible();

  // Pick the 0-member group → its row shows the warning, and the dual-pane editor opens.
  const groupRow = page.locator('.ant-table-row', { hasText: GROUP });
  await expect(groupRow).toContainText('0 thành viên');
  await groupRow.click();
  await expect(availRow(page)).toBeVisible(); // "Ngoài nhóm" pane lists Dev Member
  await page.screenshot({ path: `${SHOTS}/9.1-groups-transfer.png`, fullPage: true });

  // Grant: tick Dev Member in "Ngoài nhóm" → → arrow moves it to "Trong nhóm", then save.
  await availRow(page).click();
  await page.locator('button:has(.anticon-right)').click();
  await expect(inGroupRow(page)).toBeVisible();
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.locator('.ant-message')).toContainText('Đã lưu', { timeout: 10000 });

  // The member count for the group reflects the grant (table refetched).
  await expect(page.locator('.ant-table-row', { hasText: GROUP })).toContainText('1 thành viên', {
    timeout: 10000,
  });

  // Restore: re-open, remove the member via the ✕, save — so re-runs start clean.
  await page.locator('.ant-table-row', { hasText: GROUP }).click();
  await expect(inGroupRow(page)).toBeVisible();
  await inGroupRow(page).locator('.anticon-close').click();
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.locator('.ant-message')).toContainText('Đã lưu', { timeout: 10000 });
  await expect(page.locator('.ant-table-row', { hasText: GROUP })).toContainText('0 thành viên', {
    timeout: 10000,
  });

  expect(fatal, fatal.join('\n')).toEqual([]);
});
