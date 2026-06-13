import { and, eq, inArray } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { tickets, ticketMessages, participants } from '../../infra/db/schema';
import type { ParsedMail } from './parser';

export interface ThreadMatch {
  ticketId: string;
  status: string;
}

/** Pull a ticket code like `#00012` out of a subject's `[#00012]` marker. */
export function extractTicketCode(subject: string): string | null {
  const m = /\[#(\d{1,})\]/.exec(subject);
  if (!m) return null;
  return `#${m[1]!.padStart(5, '0')}`;
}

/**
 * Find the ticket an inbound mail belongs to (Story 2.3), within the project of
 * the receiving mailbox:
 *   1. In-Reply-To / References match a stored Message-ID → that ticket.
 *   2. Fallback: a `[#code]` in the subject — accepted ONLY when From is already a
 *      participant (anti-spoof, FR2). Otherwise it's treated as a new mail.
 * Returns null when nothing matches (→ create branch).
 */
export async function findThread(
  tx: DbTx,
  parsed: ParsedMail,
  projectId: number,
): Promise<ThreadMatch | null> {
  // 1 — header match (project-scoped).
  const refIds = [parsed.inReplyTo, ...parsed.references]
    .filter((x): x is string => !!x)
    .map((x) => x.trim());
  if (refIds.length > 0) {
    const [hit] = await tx
      .select({ ticketId: tickets.id, status: tickets.status })
      .from(ticketMessages)
      .innerJoin(tickets, eq(tickets.id, ticketMessages.ticketId))
      .where(and(inArray(ticketMessages.messageId, refIds), eq(tickets.projectId, projectId)))
      .limit(1);
    if (hit) return { ticketId: hit.ticketId, status: hit.status };
  }

  // 2 — subject code fallback + anti-spoof.
  const code = extractTicketCode(parsed.subject);
  if (code) {
    const [t] = await tx
      .select({ id: tickets.id, status: tickets.status })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.ticketCode, code)));
    if (t) {
      const from = parsed.from?.address;
      if (from) {
        const [member] = await tx
          .select({ id: participants.id })
          .from(participants)
          .where(and(eq(participants.ticketId, t.id), eq(participants.email, from)));
        if (member) return { ticketId: t.id, status: t.status };
      }
      // code matched but From is a stranger → spoof; do NOT join the thread.
      return null;
    }
  }

  return null;
}
