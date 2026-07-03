import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { AdminReminderService } from './admin-reminder.service';

const configSchema = z.object({
  overdueDays: z.number().int(),
  digestHour: z.number().int(),
  digestMinute: z.number().int().optional(), // đơn 12 (default 30 in the service)
  digestEnabled: z.boolean(),
  digestMaxN: z.number().int(),
  poolUnclaimedDays: z.number().int().optional(), // đơn 12 (default 2 in the service)
});
const templateSchema = z.object({
  subjectVi: z.string().min(1),
  subjectEn: z.string().min(1),
  bodyVi: z.string().min(1),
  bodyEn: z.string().min(1),
});

/** Reminder config + email-template editor + "test send" (Story 6.4). Admin → own
 *  project; SSA → X-Project header (same gate as the rest of /api/admin). */
@Controller('api/admin')
@UseGuards(SessionGuard)
export class AdminReminderController {
  constructor(
    private readonly svc: AdminReminderService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(user: SessionUser, xProject?: string): Promise<number> {
    if (user.role !== 'admin' && user.role !== 'ssa') throw new ForbiddenException();
    const p = await this.projectCtx.resolveEffective(user, xProject);
    return p.id;
  }

  @Get('reminder-config')
  async getConfig(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.svc.getConfig(user, await this.project(user, xp));
  }

  @Put('reminder-config')
  async putConfig(@CurrentUser() user: SessionUser, @Body() body: unknown, @Headers('x-project') xp?: string) {
    const parsed = configSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.putConfig(user, await this.project(user, xp), parsed.data);
  }

  @Get('email-templates')
  async listTemplates(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.svc.listTemplates(user, await this.project(user, xp));
  }

  @Put('email-templates/:key')
  async putTemplate(
    @CurrentUser() user: SessionUser,
    @Param('key') key: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = templateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.putTemplate(user, await this.project(user, xp), key, parsed.data);
  }

  @Post('email-templates/:key/test-send')
  async testSend(@CurrentUser() user: SessionUser, @Param('key') key: string, @Headers('x-project') xp?: string) {
    return this.svc.testSend(user, await this.project(user, xp), key);
  }
}
