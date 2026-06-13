import { Controller, Get, Param, Post, UseGuards, ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { users } from '../../infra/db/schema';
import { SessionGuard } from './session.guard';
import { CurrentUser } from './current-user.decorator';
import type { SessionUser } from './session.service';
import { RescueService } from './rescue.service';

/** Minimal user admin (Story 1.7). Full create/disable/assign lands in Story 9.2. */
@Controller('api/admin/users')
@UseGuards(SessionGuard)
export class AdminUsersController {
  constructor(private readonly rescue: RescueService) {}

  private assertAdmin(actor: SessionUser): void {
    if (actor.role !== 'admin' && actor.role !== 'ssa') {
      throw new ForbiddenException();
    }
  }

  @Get()
  async list(@CurrentUser() actor: SessionUser) {
    this.assertAdmin(actor);
    return withActor(systemActor, async (tx) => {
      const rows = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          disabled: users.disabled,
          projectId: users.projectId,
        })
        .from(users)
        .where(
          actor.role === 'ssa'
            ? // SSA sees all
              and()
            : eq(users.projectId, actor.projectId!),
        );
      return rows;
    });
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
