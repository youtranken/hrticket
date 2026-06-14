import { Controller, Get, Headers, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { NotificationsService } from './notifications.service';

/**
 * In-app notification bell API (Story 6.1). The list is conditional-GET friendly:
 * the client sends If-Modified-Since (the newest createdAt it has), and when nothing
 * newer exists we answer 304 with no body — so the 15s poll is nearly free on the
 * common "nothing new" path (AC2). Last-Modified carries the newest timestamp back.
 */
@Controller('api/notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Headers('if-modified-since') ifModifiedSince: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // HTTP dates are second-precision; compare truncated to whole seconds.
    const since = ifModifiedSince ? new Date(ifModifiedSince) : undefined;
    const result = await this.svc.list(user, since);

    if (since && (!result.latest || Math.floor(result.latest.getTime() / 1000) <= Math.floor(since.getTime() / 1000))) {
      res.status(304);
      return; // nothing new — empty body
    }
    if (result.latest) res.setHeader('Last-Modified', result.latest.toUTCString());
    res.setHeader('Cache-Control', 'no-cache');
    return { items: result.items, unreadCount: result.unreadCount };
  }

  @Patch(':id/read')
  async markRead(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.svc.markRead(user, Number(id));
  }

  @Post('read-all')
  async markAllRead(@CurrentUser() user: SessionUser) {
    return this.svc.markAllRead(user);
  }
}
