import { Controller, ForbiddenException, Get, Headers, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { ReportingService } from './reporting.service';
import { reportQuerySchema } from './dto/report.query';

/**
 * Report dashboard endpoints (Story 10.3, FR83). Team Lead / Admin / SSA only —
 * a Member gets a hard 403 (FR83), with RLS underneath as defense-in-depth. SSA
 * picks the project via the `X-Project` header (compare = two calls from the FE).
 */
@Controller('api/reports')
@UseGuards(SessionGuard)
export class ReportingController {
  constructor(
    private readonly svc: ReportingService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  /** Resolve the project after gating Members out (role guard, not just RLS). */
  private async project(user: SessionUser, xProject?: string): Promise<number> {
    if (user.role === 'member') throw new ForbiddenException();
    const p = await this.projectCtx.resolveEffective(user, xProject);
    return p.id;
  }

  @Get('by-time')
  async byTime(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const q = reportQuerySchema.parse(query);
    return this.svc.byTime(user, await this.project(user, xp), q.from, q.to);
  }

  @Get('by-category')
  async byCategory(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const q = reportQuerySchema.parse(query);
    return this.svc.byCategory(user, await this.project(user, xp), q.from, q.to);
  }

  @Get('by-staff')
  async byStaff(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const q = reportQuerySchema.parse(query);
    return this.svc.byStaff(user, await this.project(user, xp), q.from, q.to);
  }
}
