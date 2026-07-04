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
import { CapabilityGuard, RequireCap } from '../capabilities/capability.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { AdminBlocklistService } from './admin-blocklist.service';

const addSchema = z.object({
  email: z.string().email(),
  reason: z.string().max(500).optional(),
});

/** Blocklist administration (Story 7.1, FR100). Admin → own project; SSA → X-Project
 *  (same gate as the rest of /api/admin). */
@Controller('api/admin/blocklist')
@UseGuards(SessionGuard, CapabilityGuard)
@RequireCap('config.manage', 'config.manage_all')
export class AdminBlocklistController {
  constructor(
    private readonly svc: AdminBlocklistService,
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
