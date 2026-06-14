import { randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { tickets, projectSettings, attachments } from '../../infra/db/schema';
import { sniffType, mimeFor } from '../email-engine/magic-bytes';
import { storagePathFor, writeFile, statFile } from '../../infra/storage/fs-storage';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';

export interface UploadInput {
  fileName: string;
  content: Buffer;
}

export interface UploadResult {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: string;
}

/**
 * Upload an attachment to a reply (FR75/76) BEFORE the reply is sent. Two hard
 * server-side gates, independent of the client (AC2/AC4): a soft size cap from
 * per-project config (reject before writing disk, AC3) and a magic-byte whitelist
 * (the real signature beats the declared extension). Stored under the write-file-
 * before-commit protocol (2.5), linked to the outbound message at reply time (3.2).
 */
@Injectable()
export class UploadService {
  async store(user: SessionUser, ticketId: string, file: UploadInput): Promise<UploadResult> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({ id: tickets.id, projectId: tickets.projectId })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      if (!t) throw new NotFoundException('Ticket not found');

      const [settings] = await tx
        .select({
          allowed: projectSettings.allowedExtensions,
          capMb: projectSettings.attachmentCapMb,
        })
        .from(projectSettings)
        .where(eq(projectSettings.projectId, t.projectId));
      const allowed = new Set(settings?.allowed ?? []);
      const capBytes = (settings?.capMb ?? 50) * 1024 * 1024;

      // Soft cap (config-driven) — reject before any disk write (AC3).
      if (file.content.length > capBytes) {
        throw new HttpException(
          `File exceeds the ${settings?.capMb ?? 50}MB limit`,
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
      }

      // Whitelist by real signature, not the declared extension (AC2/AC4).
      const sniffed = sniffType(file.content);
      if (!sniffed || !allowed.has(sniffed)) {
        throw new UnprocessableEntityException('File type not allowed');
      }

      const uuid = randomUUID();
      const when = new Date();
      const relPath = storagePathFor(t.projectId, uuid, when);
      await writeFile(relPath, file.content); // BEFORE the row exists (2.5 protocol)

      const [row] = await tx
        .insert(attachments)
        .values({
          ticketId,
          fileName: file.fileName,
          mimeType: mimeFor(sniffed),
          size: file.content.length,
          storagePath: relPath,
          status: 'pending',
        })
        .returning({ id: attachments.id });

      const stat = await statFile(relPath);
      let status = 'pending';
      if (stat.exists && stat.size === file.content.length) {
        await tx.update(attachments).set({ status: 'stored' }).where(eq(attachments.id, row!.id));
        status = 'stored';
      }

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'attachment.uploaded',
        objectType: 'attachment',
        objectId: row!.id,
        newValue: { fileName: file.fileName, size: file.content.length, mimeType: mimeFor(sniffed) },
      });

      return { id: row!.id, fileName: file.fileName, mimeType: mimeFor(sniffed), size: file.content.length, status };
    });
  }
}
