import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { TicketsReadService, type TicketView } from './tickets-read.service';

@Controller('api/tickets')
@UseGuards(SessionGuard)
export class TicketsController {
  constructor(private readonly read: TicketsReadService) {}

  /** Paginated, RLS-filtered list (newest first). */
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('view') view?: string,
  ) {
    const p = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const v: TicketView = view === 'pool' || view === 'mine' ? view : 'all';
    return this.read.list(user, p, ps, v);
  }

  /** Full ticket detail (conversation + participants + tags + attachments + links). */
  @Get(':id')
  async detail(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.read.getDetail(user, id);
  }
}
