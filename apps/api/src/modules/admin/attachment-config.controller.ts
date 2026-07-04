import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CapabilityGuard, RequireCap } from '../capabilities/capability.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { AttachmentConfigService } from './attachment-config.service';

const patchSchema = z.object({
  allowedExtensions: z.array(z.string().min(1).max(16)).max(64).optional(),
  capMb: z.number().int().positive().max(10_000).optional(),
  autotag: z
    .object({
      attachment: z.boolean().optional(),
      crosspost: z.boolean().optional(),
      autoreply: z.boolean().optional(),
    })
    .optional(),
  diskAlertPct: z.number().int().min(1).max(99).optional(),
});

/** Attachment-policy config UI backend (Story 8.4). Admin → own project; SSA → X-Project. */
@Controller('api/admin/attachment-config')
@UseGuards(SessionGuard, CapabilityGuard)
@RequireCap('config.manage', 'config.manage_all')
export class AttachmentConfigController {
  constructor(
    private readonly config: AttachmentConfigService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(user: SessionUser, xProject?: string): Promise<number> {
    if (user.role !== 'admin' && user.role !== 'ssa') throw new ForbiddenException();
    const p = await this.projectCtx.resolveEffective(user, xProject);
    return p.id;
  }

  @Get()
  async get(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.config.get(await this.project(user, xp));
  }

  @Put()
  async put(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.config.update(user, await this.project(user, xp), parsed.data);
  }
}
