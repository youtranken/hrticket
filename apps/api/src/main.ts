import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { MonitorService } from './modules/monitor/monitor.service';
import { loadConfig } from './infra/config/config.schema';
import { AllExceptionsFilter } from './infra/http/all-exceptions.filter';

/** HTTP entrypoint — listens. The worker uses a separate entry (worker.ts). */
async function bootstrap(): Promise<void> {
  // Fail-fast: invalid/missing config crashes here with a readable message.
  const config = loadConfig();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  app.use(cookieParser());
  app.useGlobalFilters(new AllExceptionsFilter());
  // correct req.ip behind nginx
  (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set(
    'trust proxy',
    1,
  );
  app.enableCors({ origin: config.WEB_ORIGIN.split(','), credentials: true });
  await app.listen(config.API_PORT);
  app.get(MonitorService).start(); // worker-liveness monitor (NFR18)
  app.get(PinoLogger).log(`API listening on :${config.API_PORT}`);
}

void bootstrap();
