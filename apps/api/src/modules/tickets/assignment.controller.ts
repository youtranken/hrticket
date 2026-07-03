import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { AssignmentService } from './assignment.service';

const assignSchema = z.object({
  assigneeId: z.string().uuid(),
  categoryId: z.number().int().positive().optional(),
});
const categorySchema = z.object({ categoryId: z.number().int().positive() });

/** Claim (4.4) + manual assign / re-classify / change-category (4.5). */
@Controller('api/tickets/:id')
@UseGuards(SessionGuard)
export class AssignmentController {
  constructor(private readonly assignment: AssignmentService) {}

  @Post('claim')
  async claim(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const { over, categoryId } = z
      .object({ over: z.boolean().optional(), categoryId: z.number().int().positive().optional() })
      .parse(body ?? {});
    return this.assignment.claim(user, id, { over: over ?? false, categoryId });
  }

  /** Candidate assignees for the modal (group members, or project for "Khác"). */
  @Get('assignable-users')
  async assignable(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.assignment.assignableUsers(user, id);
  }

  /** Active categories of the ticket's project (for the change-category picker). */
  @Get('categories')
  async categories(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.assignment.categoriesForAssign(user, id);
  }

  @Post('assign')
  async assign(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.assignment.assign(user, id, parsed.data);
  }

  @Post('category')
  async changeCategory(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = categorySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.assignment.changeCategory(user, id, parsed.data.categoryId);
  }
}
