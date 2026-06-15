import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { AdminJunkRulesService } from './admin-junkrules.service';

const addSchema = z.object({
  kind: z.enum(['keyword', 'sender']),
  // .trim() BEFORE .min(1): whitespace-only "   " passes a bare .min(1) but the
  // service trims it to '' → an empty rule that matches indiscriminately.
  pattern: z.string().trim().min(1).max(200),
});

/** Junk-rule administration (Story 7.3, FR102). Admin → own project; SSA → X-Project. */
@Controller('api/admin/junk-rules')
@UseGuards(SessionGuard)
export class AdminJunkRulesController {
  constructor(
    private readonly svc: AdminJunkRulesService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(user: SessionUser, xProject?: string): Promise<number> {
    if (user.role !== 'admin' && user.role !== 'ssa') throw new ForbiddenException();
    const p = await this.projectCtx.resolveEffective(user, xProject);
    return p.id;
  }

  @Get()
  async list(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.svc.list(user, await this.project(user, xp));
  }

  @Post()
  async add(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = addSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.add(user, await this.project(user, xp), parsed.data);
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Headers('x-project') xp?: string,
  ) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('Invalid id');
    return this.svc.remove(user, await this.project(user, xp), n);
  }
}
