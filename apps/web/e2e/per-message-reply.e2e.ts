import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Story 12.4 critical-flow acceptance (CLAUDE.md L46 — outbound-reply flow).
 * Per-message Reply All seeds the composer from the CLICKED message's audience, not the
 * latest mail: clicking Reply All on an OLDER message (M1, cc a+b) must load a/b into Cc,
 * never M2's cc (c). Requires the compose stack + SEED_DEV_USERS fixtures.
 */
const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://hris:hris@localhost:5432/hris';
const sql = postgres(DB_URL);
test.afterAll(async () => {
  await sql.end();
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/inbox');
}

test('12.4: Reply All on an older message seeds THAT message’s recipients, not the latest', async ({ page }) => {
  const stamp = Date.now();
  const [member] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = 'member@dev.local'`;
  const a = `pm-a-${stamp}@ext.com`;
  const b = `pm-b-${stamp}@ext.com`;
  const c = `pm-c-${stamp}@ext.com`;

  const [tk] = await sql<{ id: string }[]>`
    INSERT INTO tickets (project_id, ticket_code, subject, requester_email, mailbox, status, assignee_id, assigned_at)
    VALUES (1, ${'#PM' + stamp}, ${'E2E per-message ' + stamp}, ${a}, 'hris.test@pmh.com.vn', 'in_progress', ${member!.id}, now())
    RETURNING id`;
  // M1 (older): from a, cc a+b. M2 (latest): from a, cc c.
  await sql`INSERT INTO ticket_messages (ticket_id, direction, from_addr, to_addrs, cc_addrs, body_text, received_at, created_at)
    VALUES (${tk!.id}, 'inbound', ${a}, ARRAY['hris.test@pmh.com.vn'], ARRAY[${a}, ${b}], 'older message', now() - interval '2 hours', now() - interval '2 hours')`;
  await sql`INSERT INTO ticket_messages (ticket_id, direction, from_addr, to_addrs, cc_addrs, body_text, received_at, created_at)
    VALUES (${tk!.id}, 'inbound', ${a}, ARRAY['hris.test@pmh.com.vn'], ARRAY[${c}], 'newer message', now() - interval '1 hour', now() - interval '1 hour')`;
  for (const e of [a, b, c]) {
    await sql`INSERT INTO participants (ticket_id, email, status) VALUES (${tk!.id}, ${e}, 'active') ON CONFLICT DO NOTHING`;
  }

  await login(page, 'member@dev.local');
  await page.goto(`/tickets/${tk!.id}`);

  // Click "Reply All" on the FIRST (older) message bubble; wait for its reply-defaults.
  const seeded = page.waitForResponse((r) => r.url().includes('/reply-defaults') && r.url().includes('mode=replyAll') && r.status() === 200);
  await page.getByRole('button', { name: 'Trả lời tất cả' }).first().click();
  await seeded;

  // The reply pane's Cc now carries M1's audience (a + b), NOT M2's (c).
  const pane = page.locator('.ant-tabs-tabpane-active');
  await expect(pane.getByText(b, { exact: false })).toBeVisible({ timeout: 10000 });
  await expect(pane.getByText(c, { exact: false })).toHaveCount(0);
});
