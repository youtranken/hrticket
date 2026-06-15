import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ReadStream } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { attachments, tickets, categories } from '../../infra/db/schema';
import { verifyFileToken, signedFileUrl } from '../../infra/crypto/signed-url';
import * as storage from '../../infra/storage/fs-storage';
import { writeAudit } from '../../infra/audit/audit';
import { writeFileViewLog } from './view-log';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from '../tickets/actor';

/** Metadata + a lazy stream factory for a stored attachment. The controller decides
 *  status code, Range slicing and Content-Disposition; the bytes are never buffered
 *  whole into RAM — `open()` returns an fs.ReadStream (AC4). */
export interface FileHandle {
  size: number;
  mimeType: string;
  fileName: string;
  /** Open a read stream over the whole file, or an inclusive [start,end] byte slice. */
  open(range?: { start: number; end: number }): ReadStream;
}

@Injectable()
export class FilesService {
  /**
   * Resolve a stored attachment behind THREE gates (3.7): a valid HMAC+TTL token
   * (tamper-proof, expires in 15 min), an authenticated session, and RLS ticket
   * visibility (the join to tickets is RLS-filtered, so an out-of-scope file looks
   * absent → 404). A copied URL opened logged-out fails the session gate (401, in
   * the guard). Returns a stream factory rather than a Buffer (8.1 — HTTP Range).
   */
  async serve(user: SessionUser, id: string, token: string): Promise<FileHandle> {
    if (!token || !verifyFileToken(id, user.id, token)) {
      throw new ForbiddenException('Invalid or expired file token');
    }
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .select({
          storagePath: attachments.storagePath,
          mimeType: attachments.mimeType,
          fileName: attachments.fileName,
          ticketId: attachments.ticketId,
          projectId: tickets.projectId,
        })
        .from(attachments)
        .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
        .where(and(eq(attachments.id, id), eq(attachments.status, 'stored')));
      if (!row) throw new NotFoundException('File not found');

      // Authoritative size from disk; also confirms the file exists before we hand
      // back a stream factory (a pending→stored row whose file went missing → 404).
      const stat = await storage.statFile(row.storagePath);
      if (!stat.exists) throw new NotFoundException('File not found');

      await writeAudit(tx, {
        projectId: row.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'file.served',
        objectType: 'attachment',
        objectId: id,
      });

      const storagePath = row.storagePath;
      return {
        size: stat.size,
        mimeType: row.mimeType,
        fileName: row.fileName,
        open: (range) => storage.createReadStreamFor(storagePath, range),
      };
    });
  }

  /**
   * Mint a short-lived signed URL for one attachment, bound to the requesting user.
   *
   * Permission (Story 8.3, FR78/FR59): the user must be able to SEE the ticket that
   * owns the file — enforced by RLS on the join to `tickets`, so an out-of-scope or
   * not-`stored` attachment is indistinguishable from a missing one → 404 (no
   * existence leak, AC1/AC2). RLS already encodes the category-group visibility and
   * the assignee carve-out (an assignee always sees their own ticket — the
   * "hold work-in-progress" exception is a USING clause in tickets_user, not a
   * special case here); Epic 9 only extends the WIP window, no app-layer branch.
   *
   * View-log (FR67/NFR5): if the ticket's category is flagged sensitive, a download
   * is recorded as `file_download` (deduped 5 min, so a player's many Range requests
   * = 1 line). Non-sensitive categories are never logged.
   */
  async mintAccessUrl(user: SessionUser, id: string): Promise<{ url: string }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .select({
          ticketId: attachments.ticketId,
          sensitive: categories.isSensitive,
        })
        .from(attachments)
        .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .where(and(eq(attachments.id, id), eq(attachments.status, 'stored')));
      if (!row) throw new NotFoundException('File not found');

      if (row.sensitive) {
        await writeFileViewLog(tx, {
          actorId: user.id,
          ticketId: row.ticketId,
          attachmentId: id,
        });
      }

      return { url: signedFileUrl(id, user.id) };
    });
  }
}
