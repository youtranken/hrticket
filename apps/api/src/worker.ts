import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { CoreModule } from './core.module';

/**
 * Worker entrypoint — same codebase, separate process, NO HTTP listener
 * (createApplicationContext, not create). The three independent loops
 * (IMAP poll · outbox sender · scheduler) are added in Epics 2/3/6.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CoreModule);
  await app.init();
  Logger.log('worker started', 'Worker');
  // Loops register here in later epics. Keep the process alive.
}

void bootstrap();
