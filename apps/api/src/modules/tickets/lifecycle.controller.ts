import { BadRequestException, Body, Controller, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TICKET_STATUSES } from '@hris/shared';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { TicketStatusService } from './ticket-status.service';
import { ReopenLockService } from './reopen-lock.service';

const statusSchema = z.object({
  to: z.enum(TICKET_STATUSES),
  snoozeUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z.string().optional(),
  reason: z.enum(['junk', 'duplicate']).optional(),
});

const lockSchema = z.object({ locked: z.boolean() });

/** Ticket lifecycle: status transitions (5.1/5.2/5.5) + reopen lock toggle (5.4). */
@Controller('api/tickets/:id')
@UseGuards(SessionGuard)
export class LifecycleController {
  constructor(
    private readonly status: TicketStatusService,
    private readonly lock: ReopenLockService,
  ) {}

  @Patch('status')
  async changeStatus(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.status.changeStatus(user, id, parsed.data);
  }

  @Post('reopen-lock')
  async setLock(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = lockSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.lock.setLock(user, id, parsed.data.locked);
  }
}
