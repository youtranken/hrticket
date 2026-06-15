import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { JunkService } from './junk.service';

const markSchema = z.object({ blockSender: z.boolean().optional() });
const spamSchema = z.object({ on: z.boolean() });

/**
 * Junk tab (Story 7.3, FR103). Visibility is enforced by RLS in the service (not by a
 * role gate here): any authenticated user may call, but the list returns only the junk
 * tickets their RLS scope allows — Admin (whole project) + the owning category group.
 * A member of an unrelated group gets an empty list. Mounted at /api/junk (NOT
 * /api/tickets/junk) to stay independent of the tickets controller.
 */
@Controller('api/junk')
@UseGuards(SessionGuard)
export class JunkController {
  constructor(private readonly svc: JunkService) {}

  @Get()
  async list(@CurrentUser() user: SessionUser) {
    return this.svc.list(user);
  }

  @Post(':id/release')
  async release(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.svc.release(user, id);
  }

  /** "Đánh dấu Rác" (7.4): close + is_junk, keep original category, optionally block. */
  @Post(':id/mark')
  async mark(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = markSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.markJunk(user, id, parsed.data);
  }

  /** "Đánh dấu Spam thread" (7.4): toggle is_spam_thread (silent replies). */
  @Post(':id/spam-thread')
  async spamThread(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = spamSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.toggleSpamThread(user, id, parsed.data.on);
  }
}
