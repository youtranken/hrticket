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
import { AdminMailBombService } from './admin-mailbomb.service';

const configSchema = z.object({ mailBombPerHour: z.number().int().min(1) });

/** Mail-bomb threshold config + held-mail ("Mail bị giữ") review (Story 7.2, FR101).
 *  Admin → own project; SSA → X-Project (same gate as the rest of /api/admin). */
@Controller('api/admin')
@UseGuards(SessionGuard)
export class AdminMailBombController {
  constructor(
    private readonly svc: AdminMailBombService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(user: SessionUser, xProject?: string): Promise<number> {
    if (user.role !== 'admin' && user.role !== 'ssa') throw new ForbiddenException();
    const p = await this.projectCtx.resolveEffective(user, xProject);
    return p.id;
  }

  @Get('mail-bomb-config')
  async getConfig(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.svc.getConfig(user, await this.project(user, xp));
  }

  @Put('mail-bomb-config')
  async putConfig(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = configSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.putConfig(user, await this.project(user, xp), parsed.data.mailBombPerHour);
  }

  @Get('suppressed')
  async listSuppressed(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.svc.listSuppressed(user, await this.project(user, xp));
  }

  @Post('suppressed/:id/reprocess')
  async reprocess(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Headers('x-project') xp?: string,
  ) {
    return this.svc.reprocess(user, await this.project(user, xp), id);
  }

  @Post('suppressed/:id/ignore')
  async ignore(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Headers('x-project') xp?: string,
  ) {
    return this.svc.ignore(user, await this.project(user, xp), id);
  }
}
