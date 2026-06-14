import { Injectable, Logger } from '@nestjs/common';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { projects as projectsTable } from '../../infra/db/schema';
import { PollerService } from '../email-engine/poller.service';
import { OutboxSender } from '../email-engine/outbox-sender.service';
import { IntakeService } from '../intake/intake.service';
import { repairAttachments } from '../intake/attachment-repair';
import { ReminderService } from '../reminders/reminder.service';
import { startLoop } from './loop-runner';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000); // NFR3: 60s
const OUTBOX_INTERVAL_MS = Number(process.env.OUTBOX_INTERVAL_MS ?? 10_000);
// Scheduler ticks every minute so the digest fires close to its configured VN hour;
// the attachment-repair sweep only needs to run ~hourly, so it's gated by a counter.
const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000);
const REPAIR_EVERY_TICKS = 60;

/**
 * Owns the worker's THREE independent loops (Story 2.7): IMAP poll+intake, outbox
 * sender (Epic 3 fills the body — heartbeat-only frame here), and scheduler
 * (currently the attachment-repair sweep; Epic 6 adds reminders/digests). Each
 * loop has its own try/catch + cadence (startLoop), so one crashing never wedges
 * the others. Per-mailbox isolation inside the IMAP loop too (NFR6 / AC1).
 */
@Injectable()
export class WorkerRunner {
  private readonly logger = new Logger(WorkerRunner.name);
  private stops: Array<() => void> = [];

  private schedulerTicks = 0;

  constructor(
    private readonly poller: PollerService,
    private readonly intake: IntakeService,
    private readonly outboxSender: OutboxSender,
    private readonly reminders: ReminderService,
  ) {}

  start(): void {
    this.stops.push(
      startLoop({ name: 'imap_poll', intervalMs: POLL_INTERVAL_MS, tick: () => this.pollAndIntake() }, this.logger),
      startLoop({ name: 'outbox', intervalMs: OUTBOX_INTERVAL_MS, tick: () => this.outboxTick() }, this.logger),
      startLoop({ name: 'scheduler', intervalMs: SCHEDULER_INTERVAL_MS, tick: () => this.schedulerTick() }, this.logger),
    );
  }

  stop(): void {
    for (const s of this.stops) s();
    this.stops = [];
  }

  private async pollAndIntake(): Promise<void> {
    const projects = await withActor(systemActor, (tx) =>
      tx.select({ id: projectsTable.id, key: projectsTable.key }).from(projectsTable),
    );
    for (const p of projects) {
      try {
        const out = await this.poller.pollMailbox(p);
        if (out.inserted > 0) this.logger.log(`${out.mailbox}: +${out.inserted} new mail`);
      } catch (e) {
        // Isolation: a failing mailbox is logged and skipped, not allowed to block the rest.
        this.logger.error(`poll failed for project ${p.key}: ${(e as Error)?.message}`);
      }
    }
    const n = await this.intake.processReceived();
    if (n > 0) this.logger.log(`intake processed ${n} message(s)`);
  }

  private async outboxTick(): Promise<void> {
    const res = await this.outboxSender.runOnce();
    if (res.sent > 0 || res.failed > 0) {
      this.logger.log(`outbox: ${res.sent} sent, ${res.retried} retry, ${res.failed} dead-letter`);
    }
  }

  private async schedulerTick(): Promise<void> {
    // Reminders/digests every minute (the log tables dedup so re-ticks are no-ops).
    const rem = await this.reminders.runDigests();
    if (rem.digests > 0) this.logger.log(`scheduler: ${rem.digests} digest(s) enqueued`);
    // Snooze-due reminders are FIXED behaviour — run even when digest is disabled.
    const snz = await this.reminders.runSnoozeReminders();
    if (snz.reminders > 0) this.logger.log(`scheduler: ${snz.reminders} snooze reminder(s)`);

    // Attachment-repair sweep only ~hourly — it's heavier and rarely finds anything.
    if (this.schedulerTicks % REPAIR_EVERY_TICKS === 0) {
      const res = await repairAttachments();
      if (res.failed > 0 || res.orphanFiles > 0) {
        this.logger.warn(`attachment repair: ${res.failed} failed, ${res.orphanFiles} orphan files`);
      }
    }
    this.schedulerTicks += 1;
  }
}
