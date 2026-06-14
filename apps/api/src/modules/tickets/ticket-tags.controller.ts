import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { TicketTagsService } from './ticket-tags.service';

const addSchema = z.object({ tagId: z.number().int().positive() });

/** Manual tag add/remove on a ticket (Story 4.1, FR33). */
@Controller('api/tickets/:id/tags')
@UseGuards(SessionGuard)
export class TicketTagsController {
  constructor(private readonly tagsSvc: TicketTagsService) {}

  /** Tags available in this ticket's project + which are already applied. */
  @Get()
  async list(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.tagsSvc.list(user, id);
  }

  @Post()
  async add(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = addSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.tagsSvc.add(user, id, parsed.data.tagId);
  }

  @Delete(':tagId')
  async remove(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('tagId') tagId: string,
  ) {
    const n = Number(tagId);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('Invalid tag id');
    return this.tagsSvc.remove(user, id, n);
  }
}
