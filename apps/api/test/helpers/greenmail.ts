import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import nodemailer from 'nodemailer';

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
      GREENMAIL_OPTS:
        '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.api.enabled',
    })
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(60_000)
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
