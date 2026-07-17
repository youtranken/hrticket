import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CapabilityGuard, RequireCap } from '../capabilities/capability.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import type { ProjectKey } from '../../infra/db/schema';
import { EmailConnectionService } from './email-connection.service';

const connectionSchema = z.object({
  imapHost: z.string().min(1).max(255),
  imapPort: z.number().int().positive().max(65535),
  imapUser: z.string().min(1).max(255),
  smtpHost: z.string().min(1).max(255),
  smtpPort: z.number().int().positive().max(65535),
  smtpUser: z.string().min(1).max(255),
  // Blank/absent → keep the stored App Password (never required to re-type).
  password: z.string().min(1).max(255).optional(),
});

/**
 * Story 11.1 — UI for per-project IMAP/SMTP + App Password + a real "Test
 * connection". Admin → own project; SSA → any project via X-Project (FR93).
 */
@Controller('api/admin/email-connection')
@UseGuards(SessionGuard, CapabilityGuard)
@RequireCap('config.manage', 'config.manage_all')
export class EmailConnectionController {
  constructor(
    private readonly svc: EmailConnectionService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(
    user: SessionUser,
    xProject?: string,
  ): Promise<{ id: number; key: ProjectKey }> {
    if (user.role !== 'admin' && user.role !== 'ssa') throw new ForbiddenException();
    const p = await this.projectCtx.resolveEffective(user, xProject);
    return { id: p.id, key: p.key as ProjectKey };
  }

  @Get()
  async get(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    const p = await this.project(user, xp);
    return this.svc.get(p.id, p.key);
  }

  @Put()
  async put(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = connectionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    const p = await this.project(user, xp);
    return this.svc.update(user, p.id, p.key, parsed.data);
  }

  @Post('test-connection')
  async test(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = connectionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    const p = await this.project(user, xp);
    return this.svc.testConnection(user, p.id, parsed.data);
  }
}
