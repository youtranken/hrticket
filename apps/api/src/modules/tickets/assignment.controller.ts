import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { CapabilityGuard, RequireCap } from '../capabilities/capability.guard';
import { AssignmentService } from './assignment.service';

const assignSchema = z.object({
  assigneeId: z.string().uuid(),
  categoryId: z.number().int().positive().optional(),
});
const categorySchema = z.object({ categoryId: z.number().int().positive() });
const bulkAssignSchema = z.object({
  ticketIds: z.array(z.string().uuid()).min(1).max(100),
  assigneeId: z.string().uuid(),
});

/** Claim (4.4) + manual assign / re-classify / change-category (4.5). */
@Controller('api/tickets/:id')
@UseGuards(SessionGuard, CapabilityGuard)
export class AssignmentController {
  constructor(private readonly assignment: AssignmentService) {}

  @Post('claim')
  @RequireCap('ticket.claim')
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
  @RequireCap('ticket.assign_others')
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

export interface BulkAssignResult {
  ticketId: string;
  ok: boolean;
  /** Failure reason: 'needsCategory' (Khác re-classify required) or the error message. */
  error?: string;
}

/**
 * Batch manual assign (roadmap #4): ONE request instead of the FE looping N calls.
 * Each ticket runs through the SAME AssignmentService.assign (own tx, own guards),
 * so a failure mid-list never poisons the others — partial success by design, the
 * caller gets a per-ticket verdict. A "Khác" ticket needing re-classification is a
 * FAILURE here (bulk has no category picker), mirroring the old FE accounting.
 */
@Controller('api/tickets')
@UseGuards(SessionGuard, CapabilityGuard)
export class BulkAssignController {
  constructor(private readonly assignment: AssignmentService) {}

  @Post('bulk-assign')
  @RequireCap('ticket.assign_others')
  async bulkAssign(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const parsed = bulkAssignSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    const results: BulkAssignResult[] = [];
    for (const ticketId of parsed.data.ticketIds) {
      try {
        const res = await this.assignment.assign(user, ticketId, {
          assigneeId: parsed.data.assigneeId,
        });
        if (res && typeof res === 'object' && 'needsCategory' in res) {
          results.push({ ticketId, ok: false, error: 'needsCategory' });
        } else {
          results.push({ ticketId, ok: true });
        }
      } catch (e) {
        results.push({ ticketId, ok: false, error: (e as Error).message });
      }
    }
    return { results };
  }
}
