import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ParticipantsService } from './participants.service';

const patchSchema = z.object({ action: z.enum(['approve', 'reject']) });

@Controller('api/tickets/:ticketId/participants')
@UseGuards(SessionGuard)
export class ParticipantsController {
  constructor(private readonly participants: ParticipantsService) {}

  /** Approve a stranger into the thread, or reject them (FR3). */
  @Patch(':participantId')
  async patch(
    @CurrentUser() user: SessionUser,
    @Param('ticketId') ticketId: string,
    @Param('participantId') participantId: string,
    @Body() body: unknown,
  ) {
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.participants.setStatus(user, ticketId, Number(participantId), parsed.data.action);
  }
}
