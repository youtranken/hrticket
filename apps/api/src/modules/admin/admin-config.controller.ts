import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { AdminConfigService } from './admin-config.service';

const keywords = z.array(z.string()).optional();
const createCategory = z.object({
  nameVi: z.string().min(1),
  nameEn: z.string().min(1),
  isSensitive: z.boolean().optional(),
  keywords,
});
const updateCategory = z.object({
  nameVi: z.string().min(1).optional(),
  nameEn: z.string().min(1).optional(),
  isSensitive: z.boolean().optional(),
  disabled: z.boolean().optional(),
  keywords,
});
const autoAssign = z.object({
  strategy: z.enum(['round_robin', 'least_load']),
  members: z.array(z.string().uuid()),
});
const createTag = z.object({
  name: z.string().min(1),
  kind: z.enum(['manual', 'priority']),
  color: z.string().optional(),
  keywords,
});
const updateTag = z.object({
  name: z.string().min(1).optional(),
  color: z.string().optional(),
  keywords,
});

/** Admin config UI backend (Story 4.6). Admin → own project; SSA → X-Project. */
@Controller('api/admin')
@UseGuards(SessionGuard)
export class AdminConfigController {
  constructor(
    private readonly config: AdminConfigService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(user: SessionUser, xProject?: string): Promise<number> {
    if (user.role !== 'admin' && user.role !== 'ssa') throw new ForbiddenException();
    const p = await this.projectCtx.resolveEffective(user, xProject);
    return p.id;
  }

  // Categories
  @Get('categories')
  async listCategories(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.config.listCategories(await this.project(user, xp));
  }

  @Post('categories')
  async createCategory(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = createCategory.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.config.createCategory(user, await this.project(user, xp), parsed.data);
  }

  @Patch('categories/:id')
  async updateCategory(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = updateCategory.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.config.updateCategory(user, await this.project(user, xp), this.parseId(id), parsed.data);
  }

  @Delete('categories/:id')
  async deleteCategory(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Headers('x-project') xp?: string,
  ) {
    return this.config.deleteCategory(user, await this.project(user, xp), this.parseId(id));
  }

  @Put('categories/:id/auto-assign')
  async putAutoAssign(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = autoAssign.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.config.putAutoAssign(user, await this.project(user, xp), this.parseId(id), parsed.data);
  }

  // Tags
  @Get('tags')
  async listTags(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.config.listTags(await this.project(user, xp));
  }

  @Post('tags')
  async createTag(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = createTag.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.config.createTag(user, await this.project(user, xp), parsed.data);
  }

  @Patch('tags/:id')
  async updateTag(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    const parsed = updateTag.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.config.updateTag(user, await this.project(user, xp), this.parseId(id), parsed.data);
  }

  @Delete('tags/:id')
  async deleteTag(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query('confirm') confirm?: string,
    @Headers('x-project') xp?: string,
  ) {
    return this.config.deleteTag(user, await this.project(user, xp), this.parseId(id), confirm === 'true');
  }

  /** Parse a positive-integer path id; reject NaN/0/negative so it never reaches a query (P4). */
  private parseId(id: string): number {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('Invalid id');
    return n;
  }
}
