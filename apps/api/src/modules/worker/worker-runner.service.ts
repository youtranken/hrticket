import { Injectable, Logger } from '@nestjs/common';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { projects as projectsTable } from '../../infra/db/schema';
import { PollerService } from '../email-engine/poller.service';
import { IntakeService } from '../intake/intake.service';
import { repairAttachments } from '../intake/attachment-repair';
import { startLoop } from './loop-runner';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000); // NFR3: 60s
const OUTBOX_INTERVAL_MS = Number(process.env.OUTBOX_INTERVAL_MS ?? 10_000);
const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 3_600_000); // hourly

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

  constructor(
    private readonly poller: PollerService,
    private readonly intake: IntakeService,
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

  private outboxTick(): Promise<void> {
    // Outbox sender lands in Epic 3. The loop runs now so its heartbeat exists and
    // the monitor/watchdog can see all three loops alive.
    return Promise.resolve();
  }

  private async schedulerTick(): Promise<void> {
    const res = await repairAttachments();
    if (res.failed > 0 || res.orphanFiles > 0) {
      this.logger.warn(`attachment repair: ${res.failed} failed, ${res.orphanFiles} orphan files`);
    }
  }
}
