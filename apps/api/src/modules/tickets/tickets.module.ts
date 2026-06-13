import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ParticipantsController } from './participants.controller';
import { ParticipantsService } from './participants.service';
import { TicketsController } from './tickets.controller';
import { TicketsReadService } from './tickets-read.service';

/** HTTP module for ticket resources: list/detail (2.6) + participant approval (2.3). */
@Module({
  imports: [AuthModule], // SessionGuard
  controllers: [TicketsController, ParticipantsController],
  providers: [ParticipantsService, TicketsReadService],
})
export class TicketsModule {}
