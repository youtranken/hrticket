import { ImapFlow } from 'imapflow';
import type { ImapSettings } from './mail-config';

export interface FetchedMessage {
  uid: number;
  raw: string;
  /** Message-ID from the envelope (may be empty; 2.1 derives a fallback key). */
  messageId: string;
}

export interface FetchResult {
  uidValidity: string;
  messages: FetchedMessage[];
}

/** Signature of the IMAP fetch step — lets tests substitute a GreenMail-backed stub. */
export type ImapFetcher = (
  settings: ImapSettings,
  folder: string,
  lastUid: number,
) => Promise<FetchResult>;

const SOCKET_TIMEOUT_MS = 30_000;

export interface MailboxProbe {
  uidValidity: string;
  /** Next UID the server will assign — i.e. (highest existing UID + 1). */
  uidNext: number;
}

function makeClient(settings: ImapSettings): ImapFlow {
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.pass ?? '' },
    logger: false,
    // Bounded sockets so a stuck mailbox can't wedge the poll loop forever.
    socketTimeout: SOCKET_TIMEOUT_MS,
    greetingTimeout: 10_000,
    connectionTimeout: 10_000,
  });
  // ImapFlow is an EventEmitter: a socket/idle 'error' (e.g. ETIMEOUT mid-poll) emitted
  // with NO listener CRASHES the whole worker process — taking the outbox sender, intake
  // and scheduler down with it (only restart:always saves it). Control flow is already
  // driven by the connect/fetch promise rejection (caught by the caller + the loop
  // runner), so attach a no-op listener purely to neutralise the unhandled-error crash.
  client.on('error', () => {});
  return client;
}

/**
 * Fetch messages with UID strictly greater than `lastUid` from `folder`, plus the
 * mailbox UIDVALIDITY. Effectively-once is the caller's job (persist, then commit
 * the cursor). Note the IMAP `N:*` quirk: a UID range always returns at least the
 * last message even when its UID < N, so we filter client-side.
 */
export async function fetchNew(
  settings: ImapSettings,
  folder: string,
  lastUid: number,
): Promise<FetchResult> {
  const client = makeClient(settings);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const uidValidity = String(client.mailbox && (client.mailbox as { uidValidity: bigint }).uidValidity);
      const messages: FetchedMessage[] = [];
      for await (const msg of client.fetch(
        { uid: `${lastUid + 1}:*` },
        { uid: true, source: true, envelope: true },
      )) {
        if (msg.uid <= lastUid) continue; // N:* quirk — skip the re-sent last message
        messages.push({
          uid: msg.uid,
          raw: msg.source ? msg.source.toString('utf8') : '',
          messageId: msg.envelope?.messageId ?? '',
        });
      }
      messages.sort((a, b) => a.uid - b.uid);
      return { uidValidity, messages };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * Read a mailbox's high-water mark (UIDVALIDITY + UIDNEXT) WITHOUT fetching any
 * message. Used to prime the poll cursor at go-live so intake starts from "now"
 * (only new mail), never the pre-existing history.
 */
export async function probeMailbox(settings: ImapSettings, folder: string): Promise<MailboxProbe> {
  const client = makeClient(settings);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const mb = client.mailbox as { uidValidity: bigint; uidNext: number };
      return { uidValidity: String(mb.uidValidity), uidNext: Number(mb.uidNext) };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}
