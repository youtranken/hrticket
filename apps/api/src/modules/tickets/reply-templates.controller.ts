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
});

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
  async list(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    return this.svc.list(user, await this.project(user, xp));
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

  @Delete(':id')
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string, @Headers('x-project') xp?: string) {
    this.assertCanEdit(user);
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('Invalid id');
    return this.svc.remove(user, await this.project(user, xp), n);
  }
}
