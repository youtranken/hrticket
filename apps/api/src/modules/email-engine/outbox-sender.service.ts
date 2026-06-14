import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { outbox, ticketMessages, attachments, projects, notifications, users } from '../../infra/db/schema';
import type { ProjectKey } from '../../infra/db/schema';
import { smtpConfigFor } from '../../infra/mail/smtp-config';
import { readFile } from '../../infra/storage/fs-storage';
import { writeAudit } from '../../infra/audit/audit';
import { Mailer } from '../../infra/mail/mailer';

/** Backoff schedule after each failed attempt (NFR10). 5th failure → dead-letter. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];
const MAX_ATTEMPTS = 5;
const STALE_LOCK_MS = 5 * 60_000; // re-claim a row stuck in `processing` past this
const SMTP_TIMEOUT_MS = 30_000;

interface ClaimedRow {
  id: string;
  projectId: number;
  projectKey: ProjectKey;
  toAddrs: string[];
  ccAddrs: string[] | null;
  bccAddrs: string[] | null;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  headers: string | null;
  ticketId: string | null;
  messageId: string | null;
  attempts: number;
  /** The claim stamp this worker wrote; settles guard on it (optimistic lock). */
  lockedAt: Date;
}

export interface OutboxRunResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

/**
 * The outbox consumer (Story 3.1) — loop 2 of the worker. At-least-once delivery:
 *   claim (FOR UPDATE SKIP LOCKED) → set processing+locked_at → COMMIT
 *   → send SMTP with the tx CLOSED (never hold a tx across a network call, AC3)
 *   → settle in a NEW tx: done, or attempts+1 with backoff, or failed + alert.
 * A worker that dies mid-`processing` leaves a stale lock; another consumer
 * re-claims it after STALE_LOCK_MS (AC4) — at-least-once accepts the rare resend.
 */
@Injectable()
export class OutboxSender {
  private readonly logger = new Logger(OutboxSender.name);
  private readonly transports = new Map<ProjectKey, Transporter>();

  constructor(private readonly mailer: Mailer) {}

  private transportFor(key: ProjectKey): Transporter {
    let t = this.transports.get(key);
    if (!t) {
      const cfg = smtpConfigFor(key);
      t = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      });
      this.transports.set(key, t);
    }
    return t;
  }

  /** One pass over the queue. Returns counts (tests assert on these). */
  async runOnce(batchSize = 20, now = new Date()): Promise<OutboxRunResult> {
    const claimed = await this.claim(batchSize, now);
    const result: OutboxRunResult = { claimed: claimed.length, sent: 0, retried: 0, failed: 0 };

    for (const row of claimed) {
      try {
        await this.send(row);
        await this.markDone(row);
        result.sent += 1;
      } catch (e) {
        const outcome = await this.markFailure(row, (e as Error)?.message ?? 'send error');
        if (outcome === 'failed') result.failed += 1;
        else result.retried += 1;
      }
    }
    return result;
  }

  /** Claim fresh `pending` rows AND re-claim rows stuck `processing` past the lock
   *  timeout — flip them to `processing` with a fresh lock, all in one tx. */
  private async claim(batchSize: number, now: Date): Promise<ClaimedRow[]> {
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    return withActor(systemActor, async (tx) => {
      const candidates = await tx
        .select({ id: outbox.id, status: outbox.status, attempts: outbox.attempts })
        .from(outbox)
        .where(
          or(
            and(eq(outbox.status, 'pending'), lte(outbox.nextAttemptAt, now)),
            and(eq(outbox.status, 'processing'), lte(outbox.lockedAt, staleBefore)),
          ),
        )
        .orderBy(asc(outbox.nextAttemptAt))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      if (candidates.length === 0) return [];

      // A stale `processing` candidate is a prior in-flight send that never settled
      // (the worker died mid-send). Re-claiming counts as a SPENT attempt, so a
      // payload that keeps crashing the worker dead-letters instead of re-sending
      // forever (AC4 — no infinite resend). Fresh `pending` rows claim as-is.
      const claimIds: string[] = [];
      for (const c of candidates) {
        if (c.status !== 'processing') {
          claimIds.push(c.id);
          continue;
        }
        const attempts = c.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          // Backstop dead-letter: the normal throw-path dead-letter (markFailure)
          // can't run when the worker is killed mid-send, so cap it here.
          await tx
            .update(outbox)
            .set({ status: 'failed', attempts, lockedAt: null })
            .where(eq(outbox.id, c.id));
          this.logger.error(`outbox ${c.id} dead-lettered: re-claimed ${attempts}× without settling`);
        } else {
          await tx.update(outbox).set({ attempts }).where(eq(outbox.id, c.id));
          claimIds.push(c.id);
        }
      }
      if (claimIds.length === 0) return [];

      await tx
        .update(outbox)
        .set({ status: 'processing', lockedAt: now })
        .where(inArray(outbox.id, claimIds));

      const rows = await tx
        .select({
          id: outbox.id,
          projectId: outbox.projectId,
          projectKey: projects.key,
          toAddrs: outbox.toAddrs,
          ccAddrs: outbox.ccAddrs,
          bccAddrs: outbox.bccAddrs,
          subject: outbox.subject,
          bodyHtml: outbox.bodyHtml,
          bodyText: outbox.bodyText,
          headers: outbox.headers,
          ticketId: outbox.ticketId,
          messageId: outbox.messageId,
          attempts: outbox.attempts,
        })
        .from(outbox)
        .innerJoin(projects, eq(projects.id, outbox.projectId))
        .where(inArray(outbox.id, claimIds));
      // Attach this worker's claim stamp so every settle can guard on it.
      return rows.map((r) => ({ ...r, lockedAt: now }));
    });
  }

  /** Actual SMTP send — NO database transaction is open here (AC3). */
  private async send(row: ClaimedRow): Promise<void> {
    const cfg = smtpConfigFor(row.projectKey);
    const threading = row.headers
      ? (JSON.parse(row.headers) as {
          inReplyTo?: string | null;
          references?: string | null;
          autoSubmitted?: boolean;
        })
      : {};
    const files = await this.loadAttachments(row);

    await this.transportFor(row.projectKey).sendMail({
      from: cfg.from,
      to: row.toAddrs,
      cc: row.ccAddrs ?? undefined,
      bcc: row.bccAddrs ?? undefined,
      subject: row.subject,
      text: row.bodyText ?? undefined,
      html: row.bodyHtml ?? undefined,
      messageId: row.messageId ?? undefined,
      inReplyTo: threading.inReplyTo ?? undefined,
      references: threading.references ?? undefined,
      headers: threading.autoSubmitted ? { 'Auto-Submitted': 'auto-replied' } : undefined,
      attachments: files,
    });
  }

  /** Load stored attachments linked to this mail's outbound ticket_messages row. */
  private async loadAttachments(
    row: ClaimedRow,
  ): Promise<Array<{ filename: string; content: Buffer; contentType: string }>> {
    if (!row.ticketId || !row.messageId) return [];
    const ticketId = row.ticketId;
    const messageId = row.messageId;
    const rows = await withActor(systemActor, (tx) =>
      tx
        .select({
          fileName: attachments.fileName,
          mimeType: attachments.mimeType,
          storagePath: attachments.storagePath,
        })
        .from(attachments)
        .innerJoin(ticketMessages, eq(ticketMessages.id, attachments.messageId))
        .where(
          and(
            eq(ticketMessages.ticketId, ticketId),
            eq(ticketMessages.messageId, messageId),
            eq(attachments.status, 'stored'),
          ),
        ),
    );
    const files = [];
    for (const a of rows) {
      files.push({
        filename: a.fileName,
        content: await readFile(a.storagePath),
        contentType: a.mimeType,
      });
    }
    return files;
  }

  private async markDone(row: ClaimedRow): Promise<void> {
    await withActor(systemActor, (tx) =>
      tx
        .update(outbox)
        .set({ status: 'done', smtpDispatchedAt: new Date(), lockedAt: null })
        // Only settle the row WE locked: a stale re-claim by another pass must not
        // be clobbered, nor a done row resurrected.
        .where(
          and(
            eq(outbox.id, row.id),
            eq(outbox.status, 'processing'),
            eq(outbox.lockedAt, row.lockedAt),
          ),
        ),
    );
    this.logger.log(`outbox ${row.id} sent (${row.toAddrs.join(',')})`);
  }

  /** attempts+1 → backoff, or dead-letter + Admin alert at MAX_ATTEMPTS. */
  private async markFailure(row: ClaimedRow, reason: string): Promise<'retry' | 'failed'> {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const admins = await withActor(systemActor, async (tx) => {
        await tx
          .update(outbox)
          .set({ status: 'failed', attempts, lockedAt: null })
          .where(
            and(
              eq(outbox.id, row.id),
              eq(outbox.status, 'processing'),
              eq(outbox.lockedAt, row.lockedAt),
            ),
          );
        await writeAudit(tx, {
          projectId: row.projectId,
          actorLabel: 'system:outbox',
          action: 'outbox.dead_letter',
          objectType: 'outbox',
          objectId: row.id,
          newValue: { attempts, reason, to: row.toAddrs },
        });
        // Alert Admin/SSA in-app — a stuck reply must never fail silently (AC2).
        const rows = await tx
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(and(inArray(users.role, ['admin', 'ssa']), eq(users.disabled, false)));
        for (const a of rows) {
          await tx.insert(notifications).values({
            actorId: a.id,
            type: 'outbox_failed',
            payload: JSON.stringify({ outboxId: row.id, to: row.toAddrs, reason }),
          });
        }
        return rows;
      });
      // Direct SMTP heads-up (best-effort; the outbox itself just failed).
      if (admins.length > 0) {
        this.mailer
          .send({
            to: admins.map((a) => a.email).join(','),
            subject: '[HRIS] Outbound email failed',
            text: `Outbox ${row.id} dead-lettered after ${attempts} attempts: ${reason}`,
          })
          .catch(() => undefined);
      }
      this.logger.error(`outbox ${row.id} dead-lettered after ${attempts} attempts: ${reason}`);
      return 'failed';
    }

    const delay = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)]!;
    await withActor(systemActor, (tx) =>
      tx
        .update(outbox)
        .set({
          status: 'pending',
          attempts,
          lockedAt: null,
          nextAttemptAt: sql`now() + ${`${delay} milliseconds`}::interval`,
        })
        .where(
          and(
            eq(outbox.id, row.id),
            eq(outbox.status, 'processing'),
            eq(outbox.lockedAt, row.lockedAt),
          ),
        ),
    );
    this.logger.warn(`outbox ${row.id} retry ${attempts}/${MAX_ATTEMPTS} in ${delay}ms: ${reason}`);
    return 'retry';
  }
}
