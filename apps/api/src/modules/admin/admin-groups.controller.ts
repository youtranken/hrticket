import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { AdminGroupsService } from './admin-groups.service';

const setMembers = z.object({ userIds: z.array(z.string().uuid()) });
const setUserGroups = z.object({ categoryIds: z.array(z.number().int().positive()) });

/**
 * Story 9.1 — category-group membership admin. Admin → own project; SSA → X-Project.
 * TL/Member cannot reach this surface (assertAdmin). The hard boundary is RLS on the
 * tickets the membership grants; hiding the menu (FE) is only UX.
 */
@Controller('api/admin/groups')
@UseGuards(SessionGuard)
export class AdminGroupsController {
  constructor(
    private readonly groups: AdminGroupsService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(user: SessionUser, xProject?: string): Promise<number> {
    if (user.role !== 'admin' && user.role !== 'ssa') throw new ForbiddenException();
    const p = await this.projectCtx.resolveEffective(user, xProject);
    return p.id;
  }

  @Get()
  async listGroups(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.groups.listGroups(await this.project(user, xp));
  }

  @Get(':categoryId/members')
  async listMembers(
    @CurrentUser() user: SessionUser,
    @Param('categoryId') categoryId: string,
    @Headers('x-project') xp?: string,
  ) {
    return this.groups.listMembers(await this.project(user, xp), this.parseId(categoryId));
  }

  @Put(':categoryId/members')
  async setMembers(
    @CurrentUser() user: SessionUser,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = setMembers.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.groups.setMembers(
      user,
      await this.project(user, xp),
      this.parseId(categoryId),
      parsed.data.userIds,
    );
  }

  @Get('by-user/:userId')
  async listUserGroups(
    @CurrentUser() user: SessionUser,
    @Param('userId') userId: string,
    @Headers('x-project') xp?: string,
  ) {
    return this.groups.listUserGroups(await this.project(user, xp), userId);
  }

  @Put('by-user/:userId')
  async setUserGroups(
    @CurrentUser() user: SessionUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = setUserGroups.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.groups.setUserGroups(
      user,
      await this.project(user, xp),
      userId,
      parsed.data.categoryIds,
    );
  }

  /** Parse a positive-integer path id; reject NaN/0/negative before it hits a query (P4). */
  private parseId(id: string): number {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('Invalid id');
    return n;
  }
}
