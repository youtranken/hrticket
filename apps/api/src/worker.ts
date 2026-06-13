import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { CoreModule } from './core.module';
import { loadConfig } from './infra/config/config.schema';

/**
 * Worker entrypoint — same codebase, separate process, NO HTTP listener
 * (createApplicationContext, not create). The three independent loops
 * (IMAP poll · outbox sender · scheduler) are added in Epics 2/3/6.
 */
async function bootstrap(): Promise<void> {
  loadConfig(); // fail-fast, same contract as the API
  const app = await NestFactory.createApplicationContext(CoreModule, { bufferLogs: true });
  await app.init();
  Logger.log('worker started (idle — IMAP/outbox/scheduler loops land in Epics 2/3/6)', 'Worker');

  // Keep the process alive until a real loop exists. An unresolved Promise does
  // NOT keep Node running — only an active handle does — so hold a ref'd timer
  // (the CoreModule context opens no socket of its own). Epics 2/3/6 replace this
  // idle timer with the actual IMAP/outbox/scheduler loops.
  await new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => {}, 60_000);
    const shutdown = (sig: string) => {
      Logger.log(`worker received ${sig}, shutting down`, 'Worker');
      clearInterval(keepAlive);
      void app.close().then(resolve);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
}

void bootstrap();
