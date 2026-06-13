import { inboxMessages } from '../../src/infra/db/schema';
import type { ItHarness } from '../setup.it';

export interface RawOpts {
  from: string;
  to: string;
  cc?: string;
  subject?: string;
  text?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  date?: string;
  extraHeaders?: Record<string, string>;
}

/** Build a minimal raw RFC822 message for tests. */
export function makeRaw(o: RawOpts): string {
  const h: string[] = [
    `From: ${o.from}`,
    `To: ${o.to}`,
    ...(o.cc ? [`Cc: ${o.cc}`] : []),
    `Subject: ${o.subject ?? 'subject'}`,
    `Message-ID: ${o.messageId}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    `Date: ${o.date ?? 'Wed, 11 Jun 2026 10:00:00 +0000'}`,
    ...Object.entries(o.extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`),
    'Content-Type: text/plain; charset=utf-8',
  ];
  return [...h, '', o.text ?? 'body', ''].join('\r\n');
}

/** Insert a raw mail straight into inbox_messages (status received), bypassing IMAP. */
export async function seedInbox(
  db: ItHarness['db'],
  projectId: number,
  mailbox: string,
  raw: string,
  messageId: string,
): Promise<string> {
  const [row] = await db
    .insert(inboxMessages)
    .values({ projectId, mailbox, messageId, raw })
    .returning({ id: inboxMessages.id });
  return row!.id;
}
