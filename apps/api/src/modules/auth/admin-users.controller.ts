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
import { CapabilityGuard, RequireCap } from '../capabilities/capability.guard';
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
  // SSA may target a specific project; Admin is always pinned to their own (ignored).
  projectId: z.number().int().positive().optional(),
});
const setRole = z.object({ role: assignableRole });
const moveProject = z.object({ projectId: z.number().int().positive() });
const setDisabled = z.object({ disabled: z.boolean() });
const updateProfile = z
  .object({ email: z.string().email().optional(), name: z.string().min(1).optional() })
  .refine((v) => v.email !== undefined || v.name !== undefined, 'Nothing to update');

/** Full user admin (Story 9.2, FR89). Admin → own project; SSA → X-Project / all. */
@Controller('api/admin/users')
@UseGuards(SessionGuard, CapabilityGuard)
@RequireCap('user.manage')
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
    // SSA may pick the destination project from the form; Admin is pinned to their own.
    const target =
      actor.role === 'ssa' && parsed.data.projectId
        ? parsed.data.projectId
        : await this.project(actor, xp);
    return this.usersSvc.createUser(actor, target, parsed.data);
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

  @Patch(':id/profile')
  async updateProfile(
    @CurrentUser() actor: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = updateProfile.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.usersSvc.updateProfile(actor, await this.project(actor, xp), id, parsed.data);
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

  /** Move a user to another project — SSA only (cross-project authority). */
  @Patch(':id/project')
  async moveProject(@CurrentUser() actor: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    if (actor.role !== 'ssa') throw new ForbiddenException();
    const parsed = moveProject.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.usersSvc.moveToProject(actor, id, parsed.data.projectId);
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
