import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfig } from './infra/config/config.schema';

/** HTTP entrypoint — listens. The worker uses a separate entry (worker.ts). */
async function bootstrap(): Promise<void> {
  // Fail-fast: invalid/missing config crashes here with a readable message.
  const config = loadConfig();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  app.enableCors({ origin: config.WEB_ORIGIN.split(','), credentials: true });
  await app.listen(config.API_PORT);
  app.get(PinoLogger).log(`API listening on :${config.API_PORT}`);
}

void bootstrap();
