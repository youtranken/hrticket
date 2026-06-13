import { Injectable, Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { inboxMessages } from '../../infra/db/schema';
import { parseMail } from '../email-engine/parser';
import { findThread } from '../email-engine/threading';
import { isAutoSubmitted } from '../email-engine/auto-submitted';
import { writeAudit } from '../../infra/audit/audit';
import { createTicketFromMail } from './create-ticket.usecase';
import { appendMessageToTicket } from './append-message.usecase';
import { linkCrossPost } from './cross-post';

/**
 * Intake orchestrator: consume received inbound mail and turn it into tickets.
 * Pipeline order is FIXED — dedupe → blocklist → mail-bomb → junk → create-or-append
 * (CLAUDE.md invariant #5). Story 2.2 wires the create branch; the three middle
 * stages are pass-through hooks (Epic 7 fills them), append is 2.3.
 *
 * Each message is claimed FOR UPDATE SKIP LOCKED and processed in its OWN tx (one
 * use-case = one tx): a crash rolls the whole thing back, the row stays `received`,
 * and the next cycle retries cleanly (idempotent).
 */
@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  async processReceived(maxBatch = 50): Promise<number> {
    let processed = 0;
    for (let i = 0; i < maxBatch; i++) {
      const didOne = await this.processOne();
      if (!didOne) break;
      processed += 1;
    }
    return processed;
  }

  /** Claims and processes a single received message. Returns false when the queue is empty. */
  private async processOne(): Promise<boolean> {
    return withActor(systemActor, async (tx) => {
      const [row] = await tx
        .select()
        .from(inboxMessages)
        .where(eq(inboxMessages.status, 'received'))
        .orderBy(asc(inboxMessages.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return false;

      // Replay guard (AC3): if this row already produced a ticket (crash between
      // create and flip), don't create a second one — just mark it processed.
      if (row.ticketId) {
        await tx.update(inboxMessages).set({ status: 'processed' }).where(eq(inboxMessages.id, row.id));
        return true;
      }

      const parsed = await parseMail(row.raw);
      const autoReply = isAutoSubmitted(parsed.headers);

      // FIXED pipeline — middle stages are no-op hooks until Epic 7.
      // dedupe: already enforced by the (message_id, mailbox) unique at poll time.
      // blocklist / mail-bomb / junk: pass-through.

      const match = await findThread(tx, parsed, row.projectId);

      // Auto-submitted mail (FR11): never start a thread or trigger a reply.
      if (autoReply) {
        if (match) {
          await appendMessageToTicket(tx, {
            ticketId: match.ticketId,
            ticketStatus: match.status,
            projectId: row.projectId,
            inboxMessageId: row.id,
            parsed,
            isAutoReply: true,
          });
          this.logger.log(`mail ${row.id} → auto-reply appended to ${match.ticketId}`);
        } else {
          // No thread → do NOT create a ticket (kills the loop), but keep the trace.
          await tx
            .update(inboxMessages)
            .set({ status: 'processed' })
            .where(eq(inboxMessages.id, row.id));
          await writeAudit(tx, {
            projectId: row.projectId,
            actorLabel: 'system:intake',
            action: 'auto_reply_dropped',
            objectType: 'inbox_message',
            objectId: row.id,
            newValue: { messageId: row.messageId },
          });
          this.logger.log(`mail ${row.id} → auto-reply dropped (no thread, no new ticket)`);
        }
        return true;
      }

      // create-or-append: thread match (header → subject-code+anti-spoof) decides.
      if (match) {
        const res = await appendMessageToTicket(tx, {
          ticketId: match.ticketId,
          ticketStatus: match.status,
          projectId: row.projectId,
          inboxMessageId: row.id,
          parsed,
        });
        this.logger.log(
          `mail ${row.id} → append ticket ${match.ticketId}` +
            (res.strangers.length ? ` (stranger: ${res.strangers.join(',')})` : ''),
        );
      } else {
        const res = await createTicketFromMail(tx, {
          projectId: row.projectId,
          mailbox: row.mailbox,
          inboxMessageId: row.id,
          parsed,
        });
        // Cross-post: link/tag if the same Message-ID already became a ticket elsewhere.
        await linkCrossPost(tx, {
          ticketId: res.ticketId,
          projectId: row.projectId,
          mailbox: row.mailbox,
          messageId: row.messageId,
        });
        this.logger.log(`mail ${row.id} → ticket ${res.ticketCode}`);
      }
      return true;
    });
  }
}
