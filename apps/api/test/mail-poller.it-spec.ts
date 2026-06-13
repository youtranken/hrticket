import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import {
  startGreenMail,
  injectMail,
  resetMail,
  useGreenMailForHris,
  useGreenMailForCnb,
  type GreenMail,
} from './helpers/greenmail';
import { PollerService } from '../src/modules/email-engine/poller.service';
import { inboxMessages, imapCursor } from '../src/infra/db/schema';
import type { ImapFetcher } from '../src/infra/mail/imap-client';

/**
 * IT-MAIL-001..005 — Story 2.1: IMAP poll + effectively-once dedupe.
 * Needs Docker (Postgres + GreenMail); self-skips otherwise.
 */
describe('IT-MAIL: imap poller + dedupe', () => {
  let harness: ItHarness | undefined;
  let gm: GreenMail | undefined;
  let poller: PollerService;
  let ready = false;
  const HRIS = { id: 1, key: 'hris' as const };
  const CNB = { id: 2, key: 'cnb' as const };
  // Distinct mailboxes — NOT plus-aliases (GreenMail canonicalises a+b@x → a@x,
  // which would collapse the two cross-post mailboxes into one).
  const HRIS_BOX = 'hris@test.local';
  const CNB_BOX = 'cnb@test.local';

  const countInbox = async (): Promise<number> => {
    const rows = await harness!.db.select({ id: inboxMessages.id }).from(inboxMessages);
    return rows.length;
  };

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      gm = await startGreenMail();
      useGreenMailForHris(gm, HRIS_BOX);
      useGreenMailForCnb(gm, CNB_BOX);
      poller = new PollerService();
      ready = true;
    } catch (e) {
      console.warn('[IT-MAIL] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (gm) await gm.stop();
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(inboxMessages);
      await harness!.db.delete(imapCursor);
      await resetMail(gm!); // empty the GreenMail mailboxes too
    }
  });

  it('IT-MAIL-001: polls new mail once; re-poll adds nothing (dedupe)', async () => {
    if (!ready) return;
    for (let i = 1; i <= 3; i++) {
      await injectMail(gm!, {
        from: `sender${i}@x.com`,
        to: HRIS_BOX,
        subject: `Mail ${i}`,
        text: `body ${i}`,
        messageId: `<m1-${i}@x.com>`,
      });
    }
    const first = await poller.pollMailbox(HRIS);
    expect(first.inserted).toBe(3);
    expect(await countInbox()).toBe(3);

    const second = await poller.pollMailbox(HRIS);
    expect(second.inserted).toBe(0); // cursor advanced → nothing new
    expect(await countInbox()).toBe(3);
  });

  it('IT-MAIL-002: crash before cursor commit → re-fetch deduped, no dup', async () => {
    if (!ready) return;
    await injectMail(gm!, {
      from: 'a@x.com',
      to: HRIS_BOX,
      subject: 'persist',
      text: 'b',
      messageId: '<m2@x.com>',
    });
    await poller.pollMailbox(HRIS);
    expect(await countInbox()).toBe(1);

    // Simulate a crash AFTER persist but BEFORE the cursor advanced: rewind the cursor.
    await harness!.db.update(imapCursor).set({ lastUid: 0 }).where(eq(imapCursor.mailbox, HRIS_BOX));

    const replay = await poller.pollMailbox(HRIS);
    expect(replay.inserted).toBe(0); // ON CONFLICT (message_id, mailbox) swallows it
    expect(await countInbox()).toBe(1);
  });

  it('IT-MAIL-003: UIDVALIDITY change → re-scan, no duplicate rows', async () => {
    if (!ready) return;
    await injectMail(gm!, {
      from: 'a@x.com',
      to: HRIS_BOX,
      subject: 'uidv',
      text: 'b',
      messageId: '<m3@x.com>',
    });
    await poller.pollMailbox(HRIS);
    expect(await countInbox()).toBe(1);

    // Force a UIDVALIDITY mismatch → poller re-scans from 0.
    await harness!.db
      .update(imapCursor)
      .set({ uidvalidity: 'stale-value' })
      .where(eq(imapCursor.mailbox, HRIS_BOX));

    const rescan = await poller.pollMailbox(HRIS);
    expect(rescan.inserted).toBe(0);
    expect(await countInbox()).toBe(1);
  });

  it('IT-MAIL-004: mail without Message-ID → stable fallback key (2 fetches = 1 row)', async () => {
    if (!ready) return;
    const raw = 'From: a@x.com\r\nSubject: no msgid\r\n\r\nbody-without-message-id';
    const stub: ImapFetcher = () =>
      Promise.resolve({ uidValidity: '1', messages: [{ uid: 1, raw, messageId: '' }] });

    const a = await poller.pollMailbox(HRIS, stub);
    expect(a.inserted).toBe(1);
    const b = await poller.pollMailbox(HRIS, stub);
    expect(b.inserted).toBe(0); // same raw → same synthetic key → deduped
    expect(await countInbox()).toBe(1);
  });

  it('IT-OPS-006: backlog after downtime — one poll catches up all 10 mails', async () => {
    if (!ready) return;
    for (let i = 1; i <= 10; i++) {
      await injectMail(gm!, {
        from: `u${i}@x.com`,
        to: HRIS_BOX,
        subject: `backlog ${i}`,
        text: 'b',
        messageId: `<backlog-${i}@x.com>`,
      });
    }
    // Worker was "down" while these arrived; the first poll must fetch them all.
    const out = await poller.pollMailbox(HRIS);
    expect(out.inserted).toBe(10);
    expect(await countInbox()).toBe(10);
  });

  it('IT-MAIL-005: same Message-ID to both mailboxes → 2 rows (cross-post foundation)', async () => {
    if (!ready) return;
    const messageId = '<cross-post-1@x.com>';
    await injectMail(gm!, { from: 'a@x.com', to: HRIS_BOX, subject: 'x-post', text: 'b', messageId });
    await injectMail(gm!, {
      from: 'a@x.com',
      to: CNB_BOX,
      subject: 'x-post',
      text: 'b',
      messageId,
    });

    await poller.pollMailbox(HRIS);
    await poller.pollMailbox(CNB);

    const rows = await harness!.db
      .select({ mailbox: inboxMessages.mailbox, messageId: inboxMessages.messageId })
      .from(inboxMessages);
    expect(rows).toHaveLength(2); // composite key allows one per mailbox
    expect(new Set(rows.map((r) => r.mailbox)).size).toBe(2);
    expect(new Set(rows.map((r) => r.messageId))).toEqual(new Set([messageId]));
  });
});
