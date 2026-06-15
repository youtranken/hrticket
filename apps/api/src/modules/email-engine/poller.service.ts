import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { inboxMessages, imapCursor } from '../../infra/db/schema';
import type { ProjectKey } from '../../infra/db/schema';
import { sha256 } from '../../infra/crypto/password';
import { resolveImapConfig } from '../../infra/mail/connection-resolver';
import { fetchNew, type FetchResult, type ImapFetcher } from '../../infra/mail/imap-client';

export interface PollProject {
  id: number;
  key: ProjectKey;
}

export interface PollOutcome {
  mailbox: string;
  fetched: number;
  inserted: number;
}

/** Stable dedup key for the rare mail with no Message-ID (effectively-once still holds). */
function fallbackKey(raw: string): string {
  return `<no-msgid-${sha256(raw)}@local>`;
}

/**
 * IMAP poll for one mailbox, effectively-once (NFR8): persist raw mail with a
 * composite (message_id, mailbox) dedup, THEN advance the cursor. A crash between
 * the two re-fetches and ON CONFLICT swallows the dup — nothing lost, nothing
 * doubled. UIDVALIDITY change → re-scan from 0 (dedup covers the overlap).
 */
@Injectable()
export class PollerService {
  private readonly logger = new Logger(PollerService.name);

  /** `fetcher` is injectable for tests (the IT harness drives a GreenMail client). */
  async pollMailbox(project: PollProject, fetcher: ImapFetcher = fetchNew): Promise<PollOutcome> {
    // DB-over-env (Story 11.1): read the live connection each cycle so an SSA edit
    // applies next poll without a restart.
    const cfg = await resolveImapConfig(project.key);

    const cursor = await withActor(systemActor, async (tx) => {
      const [existing] = await tx
        .select()
        .from(imapCursor)
        .where(eq(imapCursor.mailbox, cfg.mailbox));
      if (existing) return existing;
      await tx
        .insert(imapCursor)
        .values({ mailbox: cfg.mailbox })
        .onConflictDoNothing({ target: imapCursor.mailbox });
      const [row] = await tx.select().from(imapCursor).where(eq(imapCursor.mailbox, cfg.mailbox));
      return row!;
    });

    let result: FetchResult = await fetcher(cfg.imap, cursor.folder, cursor.lastUid);

    // UIDVALIDITY changed → the old UIDs are meaningless; re-scan the whole folder.
    let baseUid = cursor.lastUid;
    if (cursor.uidvalidity && cursor.uidvalidity !== result.uidValidity) {
      this.logger.warn(
        `UIDVALIDITY changed for ${cfg.mailbox} (${cursor.uidvalidity} → ${result.uidValidity}); re-scanning`,
      );
      baseUid = 0;
      result = await fetcher(cfg.imap, cursor.folder, 0);
    }

    // Persist first (durable), then advance the cursor.
    let inserted = 0;
    await withActor(systemActor, async (tx) => {
      for (const m of result.messages) {
        const messageId = m.messageId || fallbackKey(m.raw);
        const rows = await tx
          .insert(inboxMessages)
          .values({ projectId: project.id, mailbox: cfg.mailbox, messageId, raw: m.raw })
          .onConflictDoNothing({ target: [inboxMessages.messageId, inboxMessages.mailbox] })
          .returning({ id: inboxMessages.id });
        if (rows.length > 0) inserted += 1;
      }
    });

    const maxUid = result.messages.reduce((mx, m) => Math.max(mx, m.uid), baseUid);
    await withActor(systemActor, (tx) =>
      tx
        .update(imapCursor)
        .set({ lastUid: maxUid, uidvalidity: result.uidValidity })
        .where(eq(imapCursor.mailbox, cfg.mailbox)),
    );

    return { mailbox: cfg.mailbox, fetched: result.messages.length, inserted };
  }
}
