import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';
import { WorkerRunner } from './modules/worker/worker-runner.service';
import { loadConfig } from './infra/config/config.schema';

/**
 * Worker entrypoint — same codebase, separate process, NO HTTP listener
 * (createApplicationContext, not create). Runs the independent background loops;
 * Story 2.1 starts the IMAP poll loop (outbox sender · scheduler land in Epics 3/6).
 */
async function bootstrap(): Promise<void> {
  loadConfig(); // fail-fast, same contract as the API
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  await app.init();

  const runner = app.get(WorkerRunner);
  runner.start();
  Logger.log('worker started — IMAP poll loop running', 'Worker');

  // The loop's setTimeout keeps the event loop alive; wait for a signal to stop.
  await new Promise<void>((resolve) => {
    const shutdown = (sig: string) => {
      Logger.log(`worker received ${sig}, shutting down`, 'Worker');
      runner.stop();
      void app.close().then(resolve);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
}

void bootstrap();
