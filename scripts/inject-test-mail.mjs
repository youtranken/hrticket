// Inject one test mail into the mailbox the worker polls, to exercise sender-domain
// routing (story 4.7) by hand.
//
// Usage (from hr/app):
//   node scripts/inject-test-mail.mjs <from> [subject] [to]
// Examples:
//   node scripts/inject-test-mail.mjs an@phth.com "Hello"         # → company whose rule is *@phth.com
//   node scripts/inject-test-mail.mjs ai@gmail.com "Payroll ask"  # → keyword fallback
//
// Defaults target the running hris-e2e stack (greenmail SMTP on host port 13025, mailbox
// hris@test.local). For the default dev stack use SMTP_PORT=3025. Override with env:
// SMTP_HOST, SMTP_PORT, MAIL_TO.
/* global process, console */
import nodemailer from 'nodemailer';

const from = process.argv[2] ?? 'an@phth.com';
const subject = process.argv[3] ?? `Test 4.7 ${Date.now()}`;
const to = process.argv[4] ?? process.env.MAIL_TO ?? 'hris@test.local';

const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? 'localhost',
  port: Number(process.env.SMTP_PORT ?? 13025),
  secure: false,
  tls: { rejectUnauthorized: false },
});

await t.sendMail({
  from,
  to,
  subject,
  text: 'Test mail for sender-domain routing (story 4.7).',
  messageId: `<manual-${Date.now()}@test>`,
});
t.close();
console.log(`Sent: from=${from} to=${to} subject="${subject}"`);
console.log('Wait ~5-10s (worker polls every 5s), then refresh the Inbox in the web UI.');
