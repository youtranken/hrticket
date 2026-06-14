import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { EmailEngineModule } from './modules/email-engine/email-engine.module';
import { IntakeModule } from './modules/intake/intake.module';
import { WorkerRunner } from './modules/worker/worker-runner.service';
import { ReminderService } from './modules/reminders/reminder.service';

/** DI module the worker process boots (HTTP-less). Holds the background loops. */
@Module({
  imports: [CoreModule, EmailEngineModule, IntakeModule],
  providers: [WorkerRunner, ReminderService],
  exports: [WorkerRunner],
})
export class WorkerModule {}
