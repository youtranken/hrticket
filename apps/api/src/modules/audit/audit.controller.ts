import { BadRequestException, Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { CapabilityGuard, RequireCap } from '../capabilities/capability.guard';
import { AuditService } from './audit.service';

// A parseable date/datetime bound. Without this guard a value like '2026-99-99' or
// 'foo' reaches Postgres `::timestamptz` (list) or `new Date()` (view-log) and raises
// an unhandled 500 instead of a clean 400. Accepts both 'YYYY-MM-DD' and full ISO.
const dateBound = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'INVALID_DATE')
  .optional();

const auditQuery = z.object({
  from: dateBound,
  to: dateBound,
  actorId: z.string().uuid().optional(),
  action: z.string().optional(),
  objectType: z.string().optional(),
  ticketId: z.string().uuid().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const viewLogQuery = z.object({
  ticketId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  from: dateBound,
  to: dateBound,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Story 9.5 — audit + sensitive view-log reader. Member → 403 (service-enforced);
 *  Admin/TL → own project; SSA → active project via X-Project. */
@Controller('api/audit')
@UseGuards(SessionGuard, CapabilityGuard)
@RequireCap('log.read_group')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(actor: SessionUser, xProject?: string): Promise<number> {
    const p = await this.projectCtx.resolveEffective(actor, xProject);
    return p.id;
  }

  @Get()
  async list(
    @CurrentUser() actor: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = auditQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid query');
    return this.audit.list(actor, await this.project(actor, xp), parsed.data);
  }

  /** Distinct action codes for the filter dropdown (#55). */
  @Get('actions')
  async actions(@CurrentUser() actor: SessionUser, @Headers('x-project') xp?: string) {
    return { actions: await this.audit.listActions(actor, await this.project(actor, xp)) };
  }

  @Get('view-log')
  async viewLog(
    @CurrentUser() actor: SessionUser,
    @Query() query: Record<string, unknown>,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = viewLogQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid query');
    return this.audit.viewLogList(actor, await this.project(actor, xp), parsed.data);
  }
}
