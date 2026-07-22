import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { tickets } from '../../infra/db/schema';
import { verifySigned } from '../../infra/crypto/signing';

/** Coarse public buckets — the requester only ever sees these four, never the internal
 *  open/assigned/in_progress/pending/resolved/closed states or any thread content.
 *  Story 12.8: `pending` gets its own "awaiting" bucket (split from processing) so a
 *  requester can tell the ticket is on hold rather than actively being worked. */
export type PublicStatusBucket = 'received' | 'processing' | 'awaiting' | 'closed';

export function bucketOf(status: string): PublicStatusBucket {
  if (status === 'resolved' || status === 'closed') return 'closed';
  if (status === 'pending') return 'awaiting';
  if (status === 'in_progress') return 'processing';
  return 'received'; // open, assigned (and any unexpected value)
}

export interface PublicStatusView {
  ticketCode: string;
  subject: string;
  status: PublicStatusBucket;
  createdAt: string;
}

/**
 * Token-signed, no-auth ticket status lookup (#7). The token is `sign(ticketId)` (HMAC,
 * shipped in the auto-ack email); a forged or tampered token fails the HMAC check and is
 * indistinguishable from "not found". We read with the systemActor (the requester has no
 * session) and return ONLY a coarse bucket + code + subject — nothing sensitive.
 */
@Injectable()
export class PublicStatusService {
  async byToken(token: string): Promise<PublicStatusView> {
    const ticketId = verifySigned(token);
    if (!ticketId) throw new NotFoundException('Invalid link');
    return withActor(systemActor, async (tx) => {
      const [t] = await tx
        .select({
          ticketCode: tickets.ticketCode,
          subject: tickets.subject,
          status: tickets.status,
          createdAt: tickets.createdAt,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      if (!t) throw new NotFoundException('Ticket not found');
      return {
        ticketCode: t.ticketCode,
        subject: t.subject,
        status: bucketOf(t.status),
        createdAt: t.createdAt.toISOString(),
      };
    });
  }
}
