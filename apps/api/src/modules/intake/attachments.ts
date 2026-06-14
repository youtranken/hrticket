import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { attachments, projectSettings } from '../../infra/db/schema';
import { sniffType, mimeFor } from '../email-engine/magic-bytes';
import { storagePathFor, writeFile, statFile } from '../../infra/storage/fs-storage';
import type { ParsedAttachment } from '../email-engine/parser';

export interface IngestAttachmentsInput {
  ticketId: string;
  messageId: string;
  projectId: number;
  when: Date;
  attachments: ParsedAttachment[];
}

/** cid (Content-ID) → stored attachment id, for inline-image rewriting (3.7). */
export type CidMap = Record<string, string>;

/**
 * Store email attachments under the write-file-before-commit protocol (A.2):
 *  - sniff the real type; only whitelisted signatures are stored (sniff beats the
 *    declared extension/Content-Type, FR74)
 *  - write the file to a UUID path FIRST, then insert the row `pending`, verify the
 *    file exists with the right size, and flip to `stored` — all in the caller's tx
 *  - unsafe files are NOT written; a metadata-only `blocked_unsafe` row keeps the
 *    trace and drives the "⚠ dangerous attachment" note in the UI (FR15)
 */
export async function ingestAttachments(tx: DbTx, input: IngestAttachmentsInput): Promise<CidMap> {
  const cidMap: CidMap = {};
  if (input.attachments.length === 0) return cidMap;

  const [settings] = await tx
    .select({ allowed: projectSettings.allowedExtensions })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, input.projectId));
  const allowed = new Set(settings?.allowed ?? []);

  for (const att of input.attachments) {
    const sniffed = sniffType(att.content);
    const safe = sniffed !== null && allowed.has(sniffed);

    if (!safe) {
      await tx.insert(attachments).values({
        ticketId: input.ticketId,
        messageId: input.messageId,
        fileName: att.filename,
        mimeType: att.contentType || 'application/octet-stream',
        size: att.content.length,
        storagePath: '', // no file on disk
        contentId: att.contentId ?? null,
        status: 'blocked_unsafe',
      });
      continue;
    }

    const uuid = randomUUID();
    const relPath = storagePathFor(input.projectId, uuid, input.when);
    await writeFile(relPath, att.content); // BEFORE the row exists

    const [row] = await tx
      .insert(attachments)
      .values({
        ticketId: input.ticketId,
        messageId: input.messageId,
        fileName: att.filename, // original name — metadata only
        mimeType: mimeFor(sniffed),
        size: att.content.length,
        storagePath: relPath,
        contentId: att.contentId ?? null,
        status: 'pending',
      })
      .returning({ id: attachments.id });

    const stat = await statFile(relPath);
    if (stat.exists && stat.size === att.content.length) {
      await tx.update(attachments).set({ status: 'stored' }).where(eq(attachments.id, row!.id));
    }
    // else: stays pending → the repair job resolves it (no permanent pending).

    if (att.contentId) cidMap[att.contentId] = row!.id;
  }

  return cidMap;
}
