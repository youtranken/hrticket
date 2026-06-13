import { Module } from '@nestjs/common';

/**
 * CoreModule — the shared DI core imported by BOTH the HTTP app (app.module.ts)
 * and the worker (worker.ts). Cross-cutting infra (db gateway, mailer, config,
 * logger, queue) will be registered here so main + worker share one wiring.
 * Empty for now (Story 1.1); populated in Stories 1.2/1.3.
 */
@Module({
  providers: [],
  exports: [],
})
export class CoreModule {}
