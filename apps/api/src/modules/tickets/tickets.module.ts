import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ParticipantsController } from './participants.controller';
import { ParticipantsService } from './participants.service';

/** HTTP module for ticket resources. Grows with Epic 2.6 (list/detail) and beyond. */
@Module({
  imports: [AuthModule], // SessionGuard
  controllers: [ParticipantsController],
  providers: [ParticipantsService],
})
export class TicketsModule {}
