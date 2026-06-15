import { BadRequestException, Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { AuditService } from './audit.service';

const auditQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
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
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Story 9.5 — audit + sensitive view-log reader. Member → 403 (service-enforced);
 *  Admin/TL → own project; SSA → active project via X-Project. */
@Controller('api/audit')
@UseGuards(SessionGuard)
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
