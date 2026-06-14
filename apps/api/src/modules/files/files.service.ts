import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { attachments, tickets } from '../../infra/db/schema';
import { verifyFileToken } from '../../infra/crypto/signed-url';
import { readFile } from '../../infra/storage/fs-storage';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from '../tickets/actor';

export interface FilePayload {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

@Injectable()
export class FilesService {
  /**
   * Serve a stored attachment behind THREE gates (3.7): a valid HMAC+TTL token
   * (tamper-proof, expires in 15 min), an authenticated session, and RLS ticket
   * visibility (the join to tickets is RLS-filtered, so an out-of-scope file looks
   * absent). A copied URL opened logged-out fails the session gate → 401 (AC2).
   */
  async serve(user: SessionUser, id: string, token: string): Promise<FilePayload> {
    if (!token || !verifyFileToken(id, token)) {
      throw new ForbiddenException('Invalid or expired file token');
    }
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .select({
          storagePath: attachments.storagePath,
          mimeType: attachments.mimeType,
          fileName: attachments.fileName,
          status: attachments.status,
          ticketId: attachments.ticketId,
          projectId: tickets.projectId,
        })
        .from(attachments)
        .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
        .where(and(eq(attachments.id, id), eq(attachments.status, 'stored')));
      if (!row) throw new NotFoundException('File not found');

      const buffer = await readFile(row.storagePath);
      await writeAudit(tx, {
        projectId: row.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'file.served',
        objectType: 'attachment',
        objectId: id,
      });
      return { buffer, mimeType: row.mimeType, fileName: row.fileName };
    });
  }
}
