import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from './session.guard';
import { CurrentUser } from './current-user.decorator';
import type { SessionUser } from './session.service';
import { RescueService } from './rescue.service';
import { AdminUsersService } from './admin-users.service';
import { ProjectContextService } from './project-context.service';

const assignableRole = z.enum(['admin', 'team_lead', 'member']);
const createUser = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: assignableRole,
  categoryIds: z.array(z.number().int().positive()).optional(),
});
const setRole = z.object({ role: assignableRole });
const setDisabled = z.object({ disabled: z.boolean() });

/** Full user admin (Story 9.2, FR89). Admin → own project; SSA → X-Project / all. */
@Controller('api/admin/users')
@UseGuards(SessionGuard)
export class AdminUsersController {
  constructor(
    private readonly rescue: RescueService,
    private readonly usersSvc: AdminUsersService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private assertAdmin(actor: SessionUser): void {
    if (actor.role !== 'admin' && actor.role !== 'ssa') throw new ForbiddenException();
  }

  private async project(actor: SessionUser, xProject?: string): Promise<number> {
    this.assertAdmin(actor);
    const p = await this.projectCtx.resolveEffective(actor, xProject);
    return p.id;
  }

  @Get()
  async list(@CurrentUser() actor: SessionUser, @Headers('x-project') xp?: string) {
    this.assertAdmin(actor);
    // SSA sees every user across projects; Admin is scoped to their own project.
    if (actor.role === 'ssa') return this.usersSvc.list(actor.projectId ?? 0, 'all');
    return this.usersSvc.list(await this.project(actor, xp), 'project');
  }

  @Post()
  async create(
    @CurrentUser() actor: SessionUser,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = createUser.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.usersSvc.createUser(actor, await this.project(actor, xp), parsed.data);
  }

  @Patch(':id/role')
  async setRole(
    @CurrentUser() actor: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = setRole.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.usersSvc.setRole(actor, await this.project(actor, xp), id, parsed.data.role);
  }

  @Patch(':id/disabled')
  async setDisabled(
    @CurrentUser() actor: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = setDisabled.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.usersSvc.setDisabled(actor, await this.project(actor, xp), id, parsed.data.disabled);
  }

  @Post(':id/reset-password')
  async resetPassword(@CurrentUser() actor: SessionUser, @Param('id') id: string) {
    this.assertAdmin(actor);
    const tempPassword = await this.rescue.resetPassword(actor, id);
    return { tempPassword }; // shown once
  }

  @Post(':id/remove-otp')
  async removeOtp(@CurrentUser() actor: SessionUser, @Param('id') id: string) {
    this.assertAdmin(actor);
    await this.rescue.removeOtp(actor, id);
    return { ok: true };
  }
}
