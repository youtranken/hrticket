import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ManualTicketService } from './manual-ticket.service';

/** Anti-OOM ceiling per file (multer buffers in memory); the real configurable cap is
 *  enforced per project inside the service. Mirrors the reply-upload controller. */
const HARD_LIMIT_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 10;

const schema = z.object({
  recipientEmail: z.string().email(),
  subject: z.string().trim().min(1).max(500),
  body: z.string().max(50000),
  categoryId: z.coerce.number().int().positive().optional(),
  assigneeId: z.string().uuid().optional(),
});

/**
 * Create a ticket by hand AND send its opening mail (manual intake). Multipart so the
 * opening mail can carry attachments in the same request. Role gating + the system-actor
 * write live in ManualTicketService.
 */
@Controller('api/tickets')
@UseGuards(SessionGuard)
export class ManualTicketController {
  constructor(private readonly svc: ManualTicketService) {}

  @Post('manual')
  @UseInterceptors(FilesInterceptor('files', MAX_FILES, { limits: { fileSize: HARD_LIMIT_BYTES } }))
  async create(
    @CurrentUser() user: SessionUser,
    @Body() body: Record<string, string>,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ) {
    const parsed = schema.safeParse({
      recipientEmail: body.recipientEmail,
      subject: body.subject,
      body: body.body ?? '',
      // Multipart sends empty fields as '' — normalise to undefined so the optionals hold.
      categoryId: body.categoryId || undefined,
      assigneeId: body.assigneeId || undefined,
    });
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.svc.create(
      user,
      parsed.data,
      (files ?? []).map((f) => ({ fileName: f.originalname, content: f.buffer })),
    );
  }
}
