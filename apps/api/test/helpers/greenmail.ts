import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { parseMail, type ParsedMail } from '../../src/modules/email-engine/parser';

export interface GreenMail {
  host: string;
  smtpPort: number;
  imapPort: number;
  apiPort: number;
  container: StartedTestContainer;
  stop: () => Promise<void>;
}

const SMTP = 3025;
const IMAP = 3143;
const API = 8080;

/**
 * GreenMail (IMAP + SMTP) for mail integration tests. Auth disabled so any login
 * maps to that user's mailbox; mail delivered via SMTP to an address is readable
 * over IMAP by logging in as that address.
 */
export async function startGreenMail(): Promise<GreenMail> {
  const container = await new GenericContainer('greenmail/standalone:2.1.0')
    .withExposedPorts(SMTP, IMAP, API)
    .withEnvironment({
      // greenmail.startup.timeout=30s: the INTERNAL per-server startup timeout
      // defaults to 2000ms — on a loaded machine the smtps/imaps SSL keystore load
      // takes longer, GreenMail's main thread throws IllegalStateException, the
      // REST API (8080) never starts, and testcontainers times out with the
      // misleading "Port 8080 not bound". Root-caused 3/7/2026 after a day of
      // "random" GreenMail suite flakes.
      GREENMAIL_OPTS:
        '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.api.enabled -Dgreenmail.startup.timeout=30000',
    })
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(150_000) // Docker is often busy (compose stack + other suites)
    .start();

  return {
    host: container.getHost(),
    smtpPort: container.getMappedPort(SMTP),
    imapPort: container.getMappedPort(IMAP),
    apiPort: container.getMappedPort(API),
    container,
    stop: async () => {
      await container.stop();
    },
  };
}

/** Purge all mailboxes (REST API) so tests start from an empty mail state. */
export async function resetMail(gm: GreenMail): Promise<void> {
  await fetch(`http://${gm.host}:${gm.apiPort}/api/service/reset`, { method: 'POST' });
}

export interface InjectMail {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

/** Deliver a mail into GreenMail via SMTP (lands in the recipient's IMAP mailbox). */
export async function injectMail(gm: GreenMail, mail: InjectMail): Promise<void> {
  const transport = nodemailer.createTransport({
    host: gm.host,
    port: gm.smtpPort,
    secure: false,
    tls: { rejectUnauthorized: false },
  });
  await transport.sendMail({
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    headers: mail.headers,
    attachments: mail.attachments,
  });
  transport.close();
}

/** Read every message delivered to an address (via IMAP), fully parsed — used to
 *  assert what the outbox sender actually delivered (headers, To/CC, body, attachments). */
export async function fetchMailbox(gm: GreenMail, address: string): Promise<ParsedMail[]> {
  const client = new ImapFlow({
    host: gm.host,
    port: gm.imapPort,
    secure: false,
    auth: { user: address, pass: 'test' },
    logger: false,
  });
  await client.connect();
  const out: ParsedMail[] = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const status = await client.status('INBOX', { messages: true });
    if ((status.messages ?? 0) > 0) {
      for await (const msg of client.fetch('1:*', { source: true })) {
        out.push(await parseMail(msg.source!.toString('utf8')));
      }
    }
  } finally {
    lock.release();
  }
  await client.logout();
  return out;
}

/** Point the hris project's SMTP env (outbox sender) at this GreenMail instance. */
export function useGreenMailSmtpForHris(gm: GreenMail, from = 'hris@test.local'): void {
  process.env.SMTP_HRIS_HOST = gm.host;
  process.env.SMTP_HRIS_PORT = String(gm.smtpPort);
  process.env.SMTP_HRIS_SECURE = 'false';
  process.env.SMTP_HRIS_FROM = from;
  delete process.env.SMTP_HRIS_USER;
  delete process.env.SMTP_HRIS_PASSWORD;
}

/** Point the cnb project's SMTP env (outbox sender) at this GreenMail instance. */
export function useGreenMailSmtpForCnb(gm: GreenMail, from = 'cnb@test.local'): void {
  process.env.SMTP_CNB_HOST = gm.host;
  process.env.SMTP_CNB_PORT = String(gm.smtpPort);
  process.env.SMTP_CNB_SECURE = 'false';
  process.env.SMTP_CNB_FROM = from;
  delete process.env.SMTP_CNB_USER;
  delete process.env.SMTP_CNB_PASSWORD;
}

/** Point the hris project's IMAP env at this GreenMail instance. */
export function useGreenMailForHris(gm: GreenMail, user = 'leminh@pmh.com.vn'): void {
  process.env.IMAP_HRIS_HOST = gm.host;
  process.env.IMAP_HRIS_PORT = String(gm.imapPort);
  process.env.IMAP_HRIS_USER = user;
  process.env.IMAP_HRIS_PASSWORD = 'test';
  process.env.IMAP_HRIS_SECURE = 'false';
}

/** Point the cnb project's IMAP env at this GreenMail instance. */
export function useGreenMailForCnb(gm: GreenMail, user = 'leminh+cnb@pmh.com.vn'): void {
  process.env.IMAP_CNB_HOST = gm.host;
  process.env.IMAP_CNB_PORT = String(gm.imapPort);
  process.env.IMAP_CNB_USER = user;
  process.env.IMAP_CNB_PASSWORD = 'test';
  process.env.IMAP_CNB_SECURE = 'false';
}
