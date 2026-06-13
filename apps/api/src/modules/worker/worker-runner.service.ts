import { Injectable, Logger } from '@nestjs/common';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { projects as projectsTable } from '../../infra/db/schema';
import { PollerService } from '../email-engine/poller.service';
import { startLoop } from './loop-runner';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000); // NFR3: 60s

/**
 * Owns the worker's long-running loops. Story 2.1 wires the IMAP poll loop;
 * the outbox-sender (Epic 3) and scheduler (Epic 6) loops slot in beside it as
 * independent loops (Story 2.7). Each mailbox is polled in isolation so one
 * connection dropping never blocks the other (NFR6 / AC4).
 */
@Injectable()
export class WorkerRunner {
  private readonly logger = new Logger(WorkerRunner.name);
  private stops: Array<() => void> = [];

  constructor(private readonly poller: PollerService) {}

  start(): void {
    this.stops.push(
      startLoop({ name: 'imap_poll', intervalMs: POLL_INTERVAL_MS, tick: () => this.pollAll() }, this.logger),
    );
  }

  stop(): void {
    for (const s of this.stops) s();
    this.stops = [];
  }

  private async pollAll(): Promise<void> {
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
  }
}
