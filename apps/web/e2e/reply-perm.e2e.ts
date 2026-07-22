import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Story 12.3 critical-flow acceptance (CLAUDE.md L46 — permission/visibility MUST have a CI e2e).
 * The reply gate was DELIBERATELY relaxed: a Member who is in the ticket's category group but is
 * NOT the assignee may now reply. This guards that relaxation AND that RLS still hides a ticket
 * outside the member's groups. Requires the compose stack + SEED_DEV_USERS fixtures.
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

async function mkTicket(code: string, categoryId: number, assigneeId: string | null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO tickets (project_id, ticket_code, subject, requester_email, mailbox, status, category_id, assignee_id, assigned_at)
    VALUES (1, ${code}, ${'E2E ' + code}, 'rp-req@ext.com', 'hris.test@pmh.com.vn', 'in_progress',
            ${categoryId}, ${assigneeId}, ${assigneeId ? new Date() : null})
    RETURNING id`;
  await sql`INSERT INTO ticket_messages (ticket_id, direction, from_addr, to_addrs, body_text, received_at)
    VALUES (${row!.id}, 'inbound', 'rp-req@ext.com', ARRAY['hris.test@pmh.com.vn'], 'need help', now())`;
  await sql`INSERT INTO participants (ticket_id, email, status)
    VALUES (${row!.id}, 'rp-req@ext.com', 'active') ON CONFLICT DO NOTHING`;
  return row!.id;
}

test('12.3: member-in-group (not assignee) can reply; a ticket outside their groups is invisible', async ({ page }) => {
  const stamp = Date.now();
  const [member] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = 'member@dev.local'`;
  const groups = await sql<{ category_id: number }[]>`
    SELECT category_id FROM user_group_membership WHERE user_id = ${member!.id}`;
  expect(groups.length).toBeGreaterThan(0);
  const inCat = groups[0]!.category_id;
  const [out] = await sql<{ id: number }[]>`
    SELECT id FROM categories
    WHERE project_id = 1 AND name_en <> 'Other' AND id NOT IN ${sql(groups.map((g) => g.category_id))}
    LIMIT 1`;

  const inTicket = await mkTicket(`#RPI${stamp}`, inCat, null); // pool, in member's group
  const outTicket = await mkTicket(`#RPO${stamp}`, out!.id, null); // category the member is NOT in

  await login(page, 'member@dev.local');

  // In-group, unassigned: the widened 12.3 gate lets a non-assignee member reply.
  const defaultsLoaded = page.waitForResponse((r) => r.url().includes('/reply-defaults') && r.status() === 200);
  await page.goto(`/tickets/${inTicket}`);
  await defaultsLoaded;
  const body = `member-in-group reply ${stamp}`;
  await page.getByPlaceholder(/Soạn câu trả lời|Write a reply/).fill(body);
  const sendBtn = page.getByRole('button', { name: /Gửi email|Send email/ });
  await expect(sendBtn).toBeEnabled({ timeout: 15000 });
  await sendBtn.click();
  // The held outbound appears in the timeline (proves the reply was accepted, not 403).
  await expect(page.getByText(body)).toBeVisible({ timeout: 10000 });

  // Out-of-group ticket: RLS hides it → detail shows no reply surface.
  await page.goto(`/tickets/${outTicket}`);
  await expect(page.getByPlaceholder(/Soạn câu trả lời|Write a reply/)).toHaveCount(0, { timeout: 10000 });
});
