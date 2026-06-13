import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { EmailEngineModule } from './modules/email-engine/email-engine.module';
import { IntakeModule } from './modules/intake/intake.module';
import { WorkerRunner } from './modules/worker/worker-runner.service';

/** DI module the worker process boots (HTTP-less). Holds the background loops. */
@Module({
  imports: [CoreModule, EmailEngineModule, IntakeModule],
  providers: [WorkerRunner],
  exports: [WorkerRunner],
})
export class WorkerModule {}
