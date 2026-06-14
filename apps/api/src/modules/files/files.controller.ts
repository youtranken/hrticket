import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { FilesService } from './files.service';

@Controller('api/files')
@UseGuards(SessionGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** Serve an attachment via signed URL (3.7) — inline images + downloads. */
  @Get(':id')
  async get(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.files.serve(user, id, token ?? '');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.fileName)}"`);
    res.setHeader('Cache-Control', 'private, max-age=900');
    // Defense-in-depth for attacker-supplied attachments served inline: never let the
    // browser MIME-sniff a stored file into HTML/JS, and neutralize any active content.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(file.buffer);
  }
}
