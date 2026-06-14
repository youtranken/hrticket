import { BadRequestException, Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { AvailabilityService } from './availability.service';

const dateOrNull = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .nullable();
const availabilitySchema = z.object({ awayFrom: dateOrNull, awayTo: dateOrNull });

/** Self + admin availability toggle (Story 4.3, FR27). */
@Controller('api')
@UseGuards(SessionGuard)
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Patch('me/availability')
  async setMine(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const parsed = availabilitySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.availability.setForSelf(user, parsed.data);
  }

  @Patch('users/:id/availability')
  async setForUser(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = availabilitySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.availability.setForUser(user, id, parsed.data);
  }
}
