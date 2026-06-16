import {
  BadRequestException,
  Controller,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { UploadService } from './upload.service';

/** Absolute safety ceiling (anti-OOM). Multer uses in-memory storage, so this bounds
 *  the RAM a single upload can buffer before the per-project soft cap is checked (G2);
 *  kept in step with nginx `client_max_body_size`. The real, configurable soft cap is
 *  enforced per project inside UploadService (AC3). True large-file support would need
 *  streaming-to-disk rather than a bigger buffer. */
const HARD_LIMIT_BYTES = 100 * 1024 * 1024;

@Controller('api/tickets/:id/attachments')
@UseGuards(SessionGuard)
export class TicketAttachmentsController {
  constructor(private readonly uploads: UploadService) {}

  /** Upload an attachment to attach to a forthcoming reply (3.6). */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: HARD_LIMIT_BYTES } }))
  async upload(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file');
    return this.uploads.store(user, id, { fileName: file.originalname, content: file.buffer });
  }
}
