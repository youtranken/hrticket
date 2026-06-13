import { Module } from '@nestjs/common';
import { IntakeService } from './intake.service';

/** Intake orchestrator — mail → ticket (create/append pipeline). */
@Module({
  providers: [IntakeService],
  exports: [IntakeService],
})
export class IntakeModule {}
