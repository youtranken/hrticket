import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { RoleCapabilitiesService } from './role-capabilities.service';

const setCell = z.object({
  role: z.string(),
  capability: z.string(),
  allowed: z.boolean(),
});

/** Story 9.4 — SSA-only role-capability editor. Admin (and below) → 403 at the API,
 *  not just the hidden menu (AC2). */
@Controller('api/ssa/role-capabilities')
@UseGuards(SessionGuard)
export class RoleCapabilitiesController {
  constructor(private readonly svc: RoleCapabilitiesService) {}

  private assertSsa(actor: SessionUser): void {
    if (actor.role !== 'ssa') throw new ForbiddenException();
  }

  @Get()
  async getMatrix(@CurrentUser() actor: SessionUser) {
    this.assertSsa(actor);
    return this.svc.getMatrix();
  }

  @Put()
  async setCell(@CurrentUser() actor: SessionUser, @Body() body: unknown) {
    const parsed = setCell.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.setCapability(actor, parsed.data.role, parsed.data.capability, parsed.data.allowed);
  }

  @Post('reset')
  async reset(@CurrentUser() actor: SessionUser) {
    return this.svc.restoreDefaults(actor);
  }
}
