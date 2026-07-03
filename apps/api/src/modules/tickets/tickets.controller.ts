import { Controller, Get, Headers, Param, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { TicketsReadService } from './tickets-read.service';
import { TicketSearchService } from './ticket-search.service';
import { ticketListQuerySchema } from './dto/ticket-list.query';
import { ticketSearchQuerySchema } from './dto/ticket-search.query';

@Controller('api/tickets')
@UseGuards(SessionGuard)
export class TicketsController {
  constructor(
    private readonly read: TicketsReadService,
    private readonly searchSvc: TicketSearchService,
  ) {}

  /** Paginated, RLS-filtered worklist (Story 10.1). Default order = shared
   *  worklist spec (FR106); full filter bar (FR79) + Pending tab (FR80). Every
   *  filter rides on top of RLS, which stays the safety net. */
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const q = ticketListQuerySchema.parse(query);
    return this.read.list(user, q, xp);
  }

  /** RLS-scoped options for the filter bar (Story 10.1) — categories/assignees/
   *  tags drawn from the caller's visible tickets. MUST precede `:id`. */
  @Get('filter-options')
  async filterOptions(@CurrentUser() user: SessionUser) {
    return this.read.filterOptions(user);
  }

  /** Per-view counts for the tab-bar badges (mine / pool / pending) — always-visible
   *  "folder counts" so the user sees what's waiting from any tab. MUST precede `:id`. */
  @Get('counts')
  async counts(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.read.counts(user, xp);
  }

  /** Vietnamese full-text + code + people search (Story 10.2, FR81). Diacritic-
   *  insensitive; visibility = ticket-join RLS. MUST precede `:id`. */
  @Get('search')
  async search(@CurrentUser() user: SessionUser, @Query() query: Record<string, unknown>) {
    const q = ticketSearchQuerySchema.parse(query);
    return this.searchSvc.search(user, q.q, q.page, q.pageSize);
  }

  /** Full ticket detail (conversation + participants + tags + attachments + links). */
  @Get(':id')
  async detail(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.read.getDetail(user, id);
  }
}
