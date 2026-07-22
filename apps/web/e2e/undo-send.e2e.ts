import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Story 12.9 critical-flow acceptance (CLAUDE.md L46 — outbound-send flow).
 * A plain reply is HELD for 8s with an inline "Hoàn tác (Ns)" countdown. Clicking Undo
 * removes the message from the thread AND keeps the composer content for edit-and-resend;
 * letting the window elapse leaves the message. Requires the compose stack + SEED_DEV_USERS.
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

async function mkTicket(code: string, assigneeId: string): Promise<string> {
  const [tk] = await sql<{ id: string }[]>`
    INSERT INTO tickets (project_id, ticket_code, subject, requester_email, mailbox, status, assignee_id, assigned_at)
    VALUES (1, ${code}, ${'E2E undo ' + code}, 'undo-req@ext.com', 'hris.test@pmh.com.vn', 'in_progress', ${assigneeId}, now())
    RETURNING id`;
  await sql`INSERT INTO ticket_messages (ticket_id, direction, from_addr, to_addrs, body_text, received_at)
    VALUES (${tk!.id}, 'inbound', 'undo-req@ext.com', ARRAY['hris.test@pmh.com.vn'], 'please reply', now())`;
  await sql`INSERT INTO participants (ticket_id, email, status)
    VALUES (${tk!.id}, 'undo-req@ext.com', 'active') ON CONFLICT DO NOTHING`;
  return tk!.id;
}

test('12.9: Undo removes the held reply and keeps the composer; letting it elapse keeps the reply', async ({ page }) => {
  const stamp = Date.now();
  const [member] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = 'member@dev.local'`;
  const t1 = await mkTicket(`#UE${stamp}`, member!.id);

  await login(page, 'member@dev.local');
  const composer = page.getByPlaceholder(/Soạn câu trả lời|Write a reply/);
  const sendBtn = page.getByRole('button', { name: /Gửi email|Send email/ });

  // --- UNDO path ---
  const seeded1 = page.waitForResponse((r) => r.url().includes('/reply-defaults') && r.status() === 200);
  await page.goto(`/tickets/${t1}`);
  await seeded1;
  const undoBody = `undo this reply ${stamp}`;
  await composer.fill(undoBody);
  await expect(sendBtn).toBeEnabled({ timeout: 15000 });
  await sendBtn.click();

  // The inline undo banner appears with a countdown; the Send button is blocked meanwhile.
  const undoBtn = page.getByRole('button', { name: /Hoàn tác/ });
  await expect(undoBtn).toBeVisible({ timeout: 5000 });
  await expect(sendBtn).toBeDisabled();
  await undoBtn.click();

  // The banner clears, the composer still holds the text to edit-and-resend, and the held
  // outbound is gone from the ticket (DB is the source of truth the thread reads from).
  await expect(undoBtn).toHaveCount(0, { timeout: 10000 });
  await expect(composer).toHaveValue(undoBody);
  await expect(async () => {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${t1} AND direction = 'outbound'`;
    expect(rows[0]!.n).toBe(0);
  }).toPass({ timeout: 5000 });

  // --- ELAPSE path (fresh ticket) ---
  const t2 = await mkTicket(`#UE${stamp}b`, member!.id);
  const seeded2 = page.waitForResponse((r) => r.url().includes('/reply-defaults') && r.status() === 200);
  await page.goto(`/tickets/${t2}`);
  await seeded2;
  const keepBody = `keep this reply ${stamp}`;
  await composer.fill(keepBody);
  await expect(sendBtn).toBeEnabled({ timeout: 15000 });
  await sendBtn.click();
  // Do NOT click Undo; wait past the 8s window → the reply stays in the thread.
  await page.waitForTimeout(9000);
  await expect(page.getByText(keepBody)).toBeVisible();
});
