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
  Logger.log('worker started', 'Worker');
}

void bootstrap();
