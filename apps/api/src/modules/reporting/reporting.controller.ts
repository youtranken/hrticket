import { Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ReportRateLimitGuard } from './report-rate-limit.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { ReportingService } from './reporting.service';
import { reportQuerySchema } from './dto/report.query';

/**
 * Report dashboard endpoints (Story 10.3, FR83 + đơn 13). Every role may call:
 * Admin sees the project, TL their groups (RLS), and a MEMBER is pinned to a
 * self-report — the service forces `assignee_id = self` for members, ignoring
 * any `assigneeId` they send. SSA picks the project via the `X-Project` header
 * (compare = two calls from the FE).
 */
@Controller('api/reports')
// SessionGuard first (sets sessionUser), then the per-user throttle (M3).
@UseGuards(SessionGuard, ReportRateLimitGuard)
export class ReportingController {
  constructor(
    private readonly svc: ReportingService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(user: SessionUser, xProject?: string): Promise<number> {
    const p = await this.projectCtx.resolveEffective(user, xProject);
    return p.id;
  }

  @Get('summary')
  async summary(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const q = reportQuerySchema.parse(query);
    return this.svc.summary(user, await this.project(user, xp), q);
  }

  @Get('by-time')
  async byTime(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const q = reportQuerySchema.parse(query);
    return this.svc.byTime(user, await this.project(user, xp), q);
  }

  @Get('by-category')
  async byCategory(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const q = reportQuerySchema.parse(query);
    return this.svc.byCategory(user, await this.project(user, xp), q);
  }

  @Get('by-staff')
  async byStaff(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const q = reportQuerySchema.parse(query);
    return this.svc.byStaff(user, await this.project(user, xp), q);
  }
}
