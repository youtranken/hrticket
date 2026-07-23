import { test, expect, type Page } from '@playwright/test';
import nodemailer from 'nodemailer';
import postgres from 'postgres';

/**
 * Forward-mode acceptance (CLAUDE.md: reply outbound is a CI-committed critical flow;
 * forward is the same outbound path). Locks the contract of the per-message Forward:
 *   1. The bubble's "Forward" link opens the Forward tab with EMPTY recipients.
 *   2. The outbound mail is `Fwd: <subject>` (no `[#code]`), carries the typed intro,
 *      the code footer and a Gmail-style "Forwarded message" header block with the
 *      original body.
 *   3. The new recipient becomes an ACTIVE participant (confirm modal acknowledged).
 *   4. The recipient's reply to the forward's Message-ID threads back to the SAME
 *      ticket (References chain of the forwarded mail is preserved).
 * Same env-tunable harness as mail-thread.e2e.ts: E2E_BASE_URL / E2E_SMTP_PORT /
 * E2E_MAILPIT_URL / DATABASE_URL (+ SEED_DEV_USERS fixtures).
 */

const DEV_PW = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://hris:hris@localhost:5432/hris';
const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';
const sql = postgres(DB_URL);
test.afterAll(async () => {
  await sql.end();
});

test.describe.configure({ timeout: 180_000 });

interface MailpitAddr {
  Name: string;
  Address: string;
}
interface MailpitMessage {
  ID: string;
  Subject: string;
  To: MailpitAddr[];
  Cc: MailpitAddr[];
}

async function injectMail(opts: {
  from: string;
  to?: string[];
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
}): Promise<void> {
  const t = nodemailer.createTransport({
    host: 'localhost',
    port: Number(process.env.E2E_SMTP_PORT ?? 3025),
    secure: false,
    tls: { rejectUnauthorized: false },
  });
  await t.sendMail({
    from: opts.from,
    to: opts.to ?? ['hris@test.local'],
    subject: opts.subject,
    text: opts.text,
    messageId: opts.messageId,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });
  t.close();
}

async function latestMailTo(rcpt: string): Promise<MailpitMessage | undefined> {
  const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages.find((m) => (m.To ?? []).some((a) => a.Address === rcpt));
}

async function mailHtml(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${id}`);
  const body = (await res.json()) as { HTML?: string; Text?: string };
  return body.HTML ?? body.Text ?? '';
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(DEV_PW);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/inbox');
}

test('forward: Fwd: subject + forwarded block + new recipient active + reply threads back', async ({
  page,
}) => {
  const stamp = `${Date.now()}`;
  const subject = `E2E forward flow ${stamp}`;
  const requester = `ann-${stamp}@company.com`;
  const partner = `partner-${stamp}@vendor.com`;
  const originalText = `Payroll figure looks off by 500k. ${stamp}`;

  await injectMail({
    from: requester,
    subject,
    text: originalText,
    messageId: `<e2e-fwd-${stamp}@company.com>`,
  });

  await login(page, 'member@dev.local');

  let ticketId = '';
  await expect(async () => {
    const rows = await sql<{ id: string }[]>`SELECT id FROM tickets WHERE subject = ${subject} LIMIT 1`;
    expect(rows.length).toBe(1);
    ticketId = rows[0]!.id;
  }).toPass({ timeout: 40_000 });

  // Hand the ticket to the member — forward shares the reply gate (assignee/TL only).
  await sql`UPDATE tickets SET assignee_id = (SELECT id FROM users WHERE email = 'member@dev.local'),
            status = 'in_progress', assigned_at = now() WHERE id = ${ticketId}`;

  await page.goto(`/tickets/${ticketId}`);

  // (1) The inbound bubble offers "Forward" → the Forward tab opens, recipients empty.
  await page.getByText(originalText).waitFor({ timeout: 15_000 });
  // The bubble link is an <a> without href (no ARIA link role) → match by text.
  await page.getByText('Chuyển tiếp', { exact: true }).first().click();
  const forwardTab = page.getByRole('tabpanel').filter({ hasText: /Đang chuyển tiếp|Forwarding/ });
  await expect(forwardTab.getByText(requester, { exact: false }).first()).toBeVisible();

  // Fill the To (tags select) + intro, then send. The partner is a NEW address →
  // the server demands the confirm modal (same gate as reply).
  const intro = `FYI - can you check this case? ${stamp}`;
  await forwardTab.locator('.ant-select').first().click();
  await page.keyboard.type(partner);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await forwardTab.getByPlaceholder(/Lời nhắn|Optional note/).fill(intro);
  await forwardTab.getByRole('button', { name: /Gửi chuyển tiếp|Send forward/ }).click();
  await page.locator('.ant-modal:visible .ant-btn-primary').click();
  await expect(page.getByText(/Đã chuyển tiếp|Forwarded/).first()).toBeVisible({ timeout: 10_000 });

  // (2) The outbound mail: Fwd: subject, intro + code footer + forwarded block.
  let out: MailpitMessage | undefined;
  await expect(async () => {
    out = await latestMailTo(partner);
    expect(out?.Subject).toBe(`Fwd: ${subject}`);
  }).toPass({ timeout: 30_000 });
  expect(out!.Subject).not.toContain('[#');
  const html = await mailHtml(out!.ID);
  expect(html).toContain(intro);
  expect(html).toContain('Mã yêu cầu / Ticket: #');
  expect(html).toContain('Forwarded message');
  expect(html).toContain(originalText);
  expect(html).toContain(requester); // From line of the forwarded header

  // (3) The partner is now an ACTIVE participant.
  const ppl = await sql<{ email: string; status: string }[]>`
    SELECT email, status FROM participants WHERE ticket_id = ${ticketId} AND email = ${partner}`;
  expect(ppl).toHaveLength(1);
  expect(ppl[0]!.status).toBe('active');

  // (4) The partner replies to the forward → SAME ticket, no new one.
  const [fwdMsg] = await sql<{ message_id: string }[]>`
    SELECT message_id FROM ticket_messages
    WHERE ticket_id = ${ticketId} AND direction = 'outbound'
    ORDER BY created_at DESC LIMIT 1`;
  const before = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${ticketId}`;
  await injectMail({
    from: partner,
    subject: `Re: Fwd: ${subject}`,
    text: 'Checked - the 500k is a missed allowance, fixing now.',
    messageId: `<e2e-fwd-${stamp}-r1@vendor.com>`,
    inReplyTo: fwdMsg!.message_id,
    references: fwdMsg!.message_id,
  });
  await expect(async () => {
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${ticketId}`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  }).toPass({ timeout: 40_000 });
  const dupes = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM tickets WHERE subject LIKE ${'%' + subject}`;
  expect(dupes[0]!.n).toBe(1);
});
