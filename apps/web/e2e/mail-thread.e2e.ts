import { test, expect, type Page } from '@playwright/test';
import nodemailer from 'nodemailer';
import postgres from 'postgres';

/**
 * Gmail-threading acceptance (CLAUDE.md: reply outbound is a CI-committed critical
 * flow). Locks the mail-conversation contract introduced after the "fragmented
 * Gmail thread" report:
 *   1. Reply-all parity — To + CC of the original mail become ACTIVE participants
 *      (minus our own mailboxes) and pre-fill the compose CC.
 *   2. Outbound subject is `Re: <original>` with NO `[#code]` marker (a changed
 *      subject splits the requester's Gmail conversation); the ticket code moves
 *      to a body footer.
 *   3. Every reply embeds the previous message as a Gmail-style `gmail_quote`
 *      blockquote — a second reply nests the quotes (│ │).
 *   4. The requester's reply to OUR outbound Message-ID appends to the SAME ticket
 *      (References matching still works without the subject marker).
 * Requires the compose stack (greenmail SMTP inject, mailpit sink, POLL_INTERVAL_MS
 * =5000) + SEED_DEV_USERS fixtures. Ports/URLs are env-tunable for the isolated
 * stack: E2E_SMTP_PORT / E2E_MAILPIT_URL / DATABASE_URL / E2E_BASE_URL.
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
  cc?: string[];
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
    cc: opts.cc,
    subject: opts.subject,
    text: opts.text,
    messageId: opts.messageId,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });
  t.close();
}

/** Latest Mailpit message addressed to `rcpt` (Mailpit lists newest first). */
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

test('mail thread: Re: subject + reply-all To/CC + code footer + nested gmail quote + reply threads back', async ({
  page,
}) => {
  const stamp = `${Date.now()}`;
  const subject = `E2E thread flow ${stamp}`;
  const requester = `ann-${stamp}@company.com`;
  const toColleague = `to2-${stamp}@company.com`;
  const ccColleague = `bob-${stamp}@company.com`;

  // Original mail: a colleague in To and one in CC — both must join the reply-all.
  await injectMail({
    from: requester,
    to: ['hris@test.local', toColleague],
    cc: [ccColleague],
    subject,
    text: 'Please confirm my remaining annual leave.',
    messageId: `<e2e-thread-${stamp}@company.com>`,
  });

  await login(page, 'member@dev.local');

  // Worker polls every 5s — wait for the ticket.
  let ticketId = '';
  await expect(async () => {
    const rows = await sql<{ id: string }[]>`SELECT id FROM tickets WHERE subject = ${subject} LIMIT 1`;
    expect(rows.length).toBe(1);
    ticketId = rows[0]!.id;
  }).toPass({ timeout: 40_000 });

  // (1) Reply-all parity: To + CC admitted as ACTIVE participants; our mailbox is not.
  const ppl = await sql<{ email: string; status: string }[]>`
    SELECT email, status FROM participants WHERE ticket_id = ${ticketId} ORDER BY email`;
  const active = ppl.filter((p) => p.status === 'active').map((p) => p.email);
  expect(active).toEqual(expect.arrayContaining([requester, toColleague, ccColleague]));
  expect(active).not.toContain('hris@test.local');

  // Hand the ticket to the member (the handler) so they can reply.
  await sql`UPDATE tickets SET assignee_id = (SELECT id FROM users WHERE email = 'member@dev.local'),
            status = 'in_progress', assigned_at = now() WHERE id = ${ticketId}`;

  const defaultsLoaded = page.waitForResponse(
    (r) => r.url().includes('/reply-defaults') && r.status() === 200,
  );
  await page.goto(`/tickets/${ticketId}`);
  await defaultsLoaded;

  // Compose CC is pre-filled with BOTH colleagues (visible as select chips).
  await expect(page.getByText(toColleague).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(ccColleague).first()).toBeVisible();

  // ── Reply #1 ──
  const reply1 = `Your remaining leave is 8 days. ${stamp}`;
  const sendBtn = page.getByRole('button', { name: /Gửi email|Send email/ });
  await page.getByPlaceholder(/Soạn câu trả lời|Write a reply/).fill(reply1);
  await expect(sendBtn).toBeEnabled({ timeout: 15_000 });
  await sendBtn.click();
  await expect(page.getByText(reply1)).toBeVisible({ timeout: 10_000 });

  // (2)+(3) The outbound mail: Re: subject, no [#code], reply-ALL audience, footer,
  // level-1 quote. Gmail semantics keep the original To-people in To (to2) and the
  // CC-people in CC (bob) — assert the union. The auto-ack ALSO goes to the requester
  // with a `Re:` subject but alone — retry until the full-audience reply lands.
  let out1: MailpitMessage | undefined;
  await expect(async () => {
    out1 = await latestMailTo(requester);
    expect(out1?.Subject).toBe(`Re: ${subject}`);
    const rcpts = [...(out1?.To ?? []), ...(out1?.Cc ?? [])].map((a) => a.Address);
    expect(rcpts).toEqual(expect.arrayContaining([requester, toColleague, ccColleague]));
  }).toPass({ timeout: 30_000 });
  expect(out1!.Subject).not.toContain('[#');
  const html1 = await mailHtml(out1!.ID);
  expect(html1).toContain('Mã yêu cầu / Ticket: #');
  expect(html1).toContain('gmail_quote'); // quotes the original inbound

  // ── Reply #2 → the quote NESTS (reply #1's quote rides inside) ──
  const reply2 = `One more thing: please hand over to a colleague first. ${stamp}`;
  await page.getByPlaceholder(/Soạn câu trả lời|Write a reply/).fill(reply2);
  await expect(sendBtn).toBeEnabled({ timeout: 15_000 });
  await sendBtn.click();
  await expect(page.getByText(reply2)).toBeVisible({ timeout: 10_000 });

  let out2: MailpitMessage | undefined;
  await expect(async () => {
    out2 = await latestMailTo(requester);
    const html2 = await mailHtml(out2!.ID);
    expect(html2).toContain(reply1); // previous reply quoted…
    expect(html2.split('gmail_quote').length - 1).toBeGreaterThanOrEqual(2); // …nested │ │
  }).toPass({ timeout: 30_000 });

  // (4) Requester replies to OUR Message-ID (no [#code] in subject) → SAME ticket.
  const [lastOut] = await sql<{ message_id: string }[]>`
    SELECT message_id FROM ticket_messages
    WHERE ticket_id = ${ticketId} AND direction = 'outbound'
    ORDER BY created_at DESC LIMIT 1`;
  const before = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${ticketId}`;
  await injectMail({
    from: requester,
    subject: `Re: ${subject}`,
    text: 'Understood, thank you!',
    messageId: `<e2e-thread-${stamp}-r2@company.com>`,
    inReplyTo: lastOut!.message_id,
    references: lastOut!.message_id,
  });
  await expect(async () => {
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${ticketId}`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  }).toPass({ timeout: 40_000 });
  // …and no second ticket was spawned for the Re: mail.
  const dupes = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM tickets WHERE subject LIKE ${'%' + subject}`;
  expect(dupes[0]!.n).toBe(1);
});
