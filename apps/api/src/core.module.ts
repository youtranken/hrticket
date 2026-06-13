import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { loggerParams } from './infra/logger';
import { CONFIG, loadConfig } from './infra/config/config.schema';

/**
 * CoreModule — shared DI core imported by BOTH the HTTP app and the worker.
 * Holds cross-cutting infra: validated config, structured logging. The DB
 * gateway is accessed via the withActor() function (not a provider) by design.
 */
@Global()
@Module({
  imports: [LoggerModule.forRoot(loggerParams)],
  providers: [
    {
      provide: CONFIG,
      useFactory: () => loadConfig(),
    },
  ],
  exports: [CONFIG],
})
export class CoreModule {}
