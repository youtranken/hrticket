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
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { ReplyTemplatesService } from './reply-templates.service';

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(20000),
  categoryId: z.number().int().positive().nullable().optional(),
});
const enabledSchema = z.object({ enabled: z.boolean() });

/** Canned reply templates. LIST is open to any agent (they use them when composing);
 *  create/edit/delete is limited to SSA/Admin/TL. SSA targets a project via X-Project. */
@Controller('api/reply-templates')
@UseGuards(SessionGuard)
export class ReplyTemplatesController {
  constructor(
    private readonly svc: ReplyTemplatesService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  private async project(user: SessionUser, xProject?: string): Promise<number> {
    return (await this.projectCtx.resolveEffective(user, xProject)).id;
  }

  private assertCanEdit(user: SessionUser): void {
    if (user.role !== 'ssa' && user.role !== 'admin' && user.role !== 'team_lead') {
      throw new ForbiddenException('Only SSA/Admin/TL may edit templates');
    }
  }

  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Headers('x-project') xp?: string,
    @Query('categoryId') categoryId?: string,
    @Query('includeDisabled') includeDisabled?: string,
  ) {
    const cat = categoryId != null && categoryId !== '' ? Number(categoryId) : undefined;
    if (cat !== undefined && (!Number.isInteger(cat) || cat <= 0)) {
      throw new BadRequestException('Invalid categoryId');
    }
    return this.svc.list(user, await this.project(user, xp), {
      categoryId: cat,
      // Manager view: only SSA/Admin/TL may see disabled rows.
      includeDisabled:
        includeDisabled === '1' &&
        (user.role === 'ssa' || user.role === 'admin' || user.role === 'team_lead'),
    });
  }

  @Post()
  async add(@CurrentUser() user: SessionUser, @Body() body: unknown, @Headers('x-project') xp?: string) {
    this.assertCanEdit(user);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.create(user, await this.project(user, xp), parsed.data);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    this.assertCanEdit(user);
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('Invalid id');
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.update(user, await this.project(user, xp), n, parsed.data);
  }

  @Patch(':id/enabled')
  async setEnabled(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-project') xp?: string,
  ) {
    this.assertCanEdit(user);
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('Invalid id');
    const parsed = enabledSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.setEnabled(user, await this.project(user, xp), n, parsed.data.enabled);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string, @Headers('x-project') xp?: string) {
    this.assertCanEdit(user);
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('Invalid id');
    return this.svc.remove(user, await this.project(user, xp), n);
  }
}
