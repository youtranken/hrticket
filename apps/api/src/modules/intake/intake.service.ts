import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { inboxMessages, users } from '../../infra/db/schema';
import { emitNotification } from '../notifications/emit';
import { parseMail } from '../email-engine/parser';
import { findThread } from '../email-engine/threading';
import { isAutoSubmitted } from '../email-engine/auto-submitted';
import { writeAudit } from '../../infra/audit/audit';
import { createTicketFromMail } from './create-ticket.usecase';
import { appendMessageToTicket } from './append-message.usecase';
import { linkCrossPost } from './cross-post';
import { isBlocked } from './blocklist';
import { checkMailBomb } from './mail-bomb';
import { matchJunkRule } from './junk-rules';

/** Inbound dead-letter tuning (mirror of the outbox sender). */
const MAX_INTAKE_ATTEMPTS = 5;
const INTAKE_BACKOFF_MS = 5 * 60_000;

interface ClaimedInbox {
  id: string;
  projectId: number;
  messageId: string;
  attempts: number;
}

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
    let claimed: ClaimedInbox | null = null;
    try {
      return await withActor(systemActor, async (tx) => {
        const [row] = await tx
          .select()
          .from(inboxMessages)
          // Compare against DB now() (NOT a JS Date): next_attempt_at defaults to DB
          // now(), and the test Postgres (Docker VM) clock can run ahead of the host's,
          // which would skip a just-seeded row and wedge intake.
          .where(and(eq(inboxMessages.status, 'received'), lte(inboxMessages.nextAttemptAt, sql`now()`)))
          .orderBy(asc(inboxMessages.createdAt))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return false;
        claimed = {
          id: row.id,
          projectId: row.projectId,
          messageId: row.messageId,
          attempts: row.attempts,
        };

        // Replay guard (AC3): if this row already produced a ticket (crash between
        // create and flip), don't create a second one — just mark it processed.
        if (row.ticketId) {
          await tx
            .update(inboxMessages)
            .set({ status: 'processed' })
            .where(eq(inboxMessages.id, row.id));
          return true;
        }

        const parsed = await parseMail(row.raw);
        const autoReply = isAutoSubmitted(parsed.headers);

        // FIXED pipeline — dedupe is enforced by the (message_id, mailbox) unique at
        // poll time; blocklist (Story 7.1) gates the create branch below; mail-bomb /
        // junk are still pass-through hooks.

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
          // Blocklist (Story 7.1, FR100): a new-ticket mail from a blocked sender is
          // dropped from the pipeline — NO ticket, NO auto-ack — but the inbox row is
          // kept (status `blocked`) + audited so it's never a silent drop (NFR8). Only
          // mail that matched no thread reaches here, so an existing participant's reply
          // (handled in the `match` branch above) is never cut (AC3).
          const fromAddr = parsed.from?.address;
          if (fromAddr && (await isBlocked(tx, row.projectId, fromAddr))) {
            await tx
              .update(inboxMessages)
              .set({ status: 'blocked' })
              .where(eq(inboxMessages.id, row.id));
            await writeAudit(tx, {
              projectId: row.projectId,
              actorLabel: 'system:intake',
              action: 'inbox.blocked',
              objectType: 'inbox_message',
              objectId: row.id,
              newValue: { from: fromAddr, messageId: row.messageId, subject: parsed.subject },
            });
            this.logger.log(`mail ${row.id} → blocked (sender ${fromAddr} on blocklist)`);
            return true;
          }

          // Mail-bomb (Story 7.2, FR101): count this new-ticket mail in the sender's
          // sliding 1h window; once over the per-project threshold, suppress it — kept
          // (status `suppressed`) + releasable + the first crosser fires one grouped
          // Admin alert. Never a silent drop (NFR8). Same new-ticket-only scope as
          // blocklist: a thread reply (handled above) is never counted/suppressed.
          if (fromAddr) {
            const bomb = await checkMailBomb(tx, {
              projectId: row.projectId,
              sender: fromAddr,
              mailbox: row.mailbox,
            });
            if (bomb.suppressed) {
              await tx
                .update(inboxMessages)
                .set({ status: 'suppressed' })
                .where(eq(inboxMessages.id, row.id));
              await writeAudit(tx, {
                projectId: row.projectId,
                actorLabel: 'system:intake',
                action: 'inbox.suppressed',
                objectType: 'inbox_message',
                objectId: row.id,
                newValue: { from: fromAddr, messageId: row.messageId, subject: parsed.subject },
              });
              this.logger.log(`mail ${row.id} → suppressed (mail-bomb, sender ${fromAddr})`);
              return true;
            }
          }

          // Junk rules (Story 7.3, FR102): a new-ticket mail matching a keyword/sender
          // rule still becomes a ticket, but is_junk=true in "Khác" — no auto-assign,
          // no auto-ack — so it lands in the Junk tab (rescuable), not the normal inbox.
          const junk = fromAddr
            ? await matchJunkRule(tx, row.projectId, {
                subject: parsed.subject,
                body: parsed.bodyText,
                from: fromAddr,
              })
            : null;

          const res = await createTicketFromMail(tx, {
            projectId: row.projectId,
            mailbox: row.mailbox,
            inboxMessageId: row.id,
            parsed,
            isJunk: !!junk,
          });
          if (junk) {
            await writeAudit(tx, {
              projectId: row.projectId,
              actorLabel: 'system:intake',
              action: 'ticket.auto_junked',
              objectType: 'ticket',
              objectId: res.ticketId,
              newValue: { ruleId: junk.ruleId, kind: junk.kind, pattern: junk.pattern },
            });
            this.logger.log(`mail ${row.id} → junk ticket ${res.ticketCode} (rule ${junk.ruleId})`);
          }
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
    } catch (e) {
      // A failure (bad parse, DB error, disk-full attachment) rolled back the whole
      // tx. Record it in a SEPARATE tx so the poison mail leaves the queue head
      // instead of being re-picked first forever and blocking every mail behind it.
      if (!claimed) throw e;
      await this.deadLetterInbound(claimed, (e as Error)?.message ?? 'intake error');
      return true;
    }
  }

  /** Off the failed row's (now rolled-back) tx: retry with backoff a few times for
   *  transient blips, then dead-letter to `failed` + alert Admin/SSA — a lost
   *  inbound mail must never be silent (NFR18). */
  private async deadLetterInbound(row: ClaimedInbox, reason: string): Promise<void> {
    const attempts = row.attempts + 1;
    await withActor(systemActor, async (tx) => {
      if (attempts >= MAX_INTAKE_ATTEMPTS) {
        await tx
          .update(inboxMessages)
          .set({ status: 'failed', attempts, lastError: reason })
          .where(eq(inboxMessages.id, row.id));
        await writeAudit(tx, {
          projectId: row.projectId,
          actorLabel: 'system:intake',
          action: 'inbox.dead_letter',
          objectType: 'inbox_message',
          objectId: row.id,
          newValue: { attempts, reason, messageId: row.messageId },
        });
        const admins = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.role, ['admin', 'ssa']), eq(users.disabled, false)));
        for (const a of admins) {
          await emitNotification(tx, {
            actorId: a.id,
            type: 'inbox_failed',
            payload: { inboxMessageId: row.id, reason },
          });
        }
        this.logger.error(`inbox ${row.id} dead-lettered after ${attempts} attempts: ${reason}`);
      } else {
        await tx
          .update(inboxMessages)
          .set({
            attempts,
            lastError: reason,
            nextAttemptAt: sql`now() + ${`${INTAKE_BACKOFF_MS} milliseconds`}::interval`,
          })
          .where(eq(inboxMessages.id, row.id));
        this.logger.warn(`inbox ${row.id} retry ${attempts}/${MAX_INTAKE_ATTEMPTS}: ${reason}`);
      }
    });
  }
}
