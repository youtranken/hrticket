import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { CapabilityGuard, RequireCap } from '../capabilities/capability.guard';
import { ReplyService } from './reply.service';
import { NotesService } from './notes.service';
import { DraftsService } from './drafts.service';

const replySchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  body: z.string().min(1),
  bodyHtml: z.string().optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
  confirmNewRecipients: z.boolean().optional(),
  closeAfter: z.boolean().optional(),
  statusAfter: z.enum(['pending', 'resolved']).optional(),
  snoozeUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  undo: z.boolean().optional(),
  // 12.10: the message being replied to → the quote + threading hook onto it (not latest).
  ticketMessageId: z.string().uuid().optional(),
});

const forwardSchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  body: z.string().optional(),
  ticketMessageId: z.string().uuid(),
  confirmNewRecipients: z.boolean().optional(),
  undo: z.boolean().optional(),
});

const undoSendSchema = z.object({ outboxId: z.string().uuid() });

const noteSchema = z.object({ body: z.string().min(1) });

const kindSchema = z.enum(['reply', 'note']);
const draftSchema = z.object({
  kind: kindSchema,
  body: z.string(),
  recipients: z.unknown().optional(),
});

/** Compose endpoints on a ticket: reply (3.2), internal note (3.4), draft (3.5).
 *  Reply and note are DELIBERATELY separate routes/handlers (C3). */
@Controller('api/tickets/:id')
@UseGuards(SessionGuard, CapabilityGuard)
export class ComposeController {
  constructor(
    private readonly replies: ReplyService,
    private readonly notes: NotesService,
    private readonly drafts: DraftsService,
  ) {}

  @Get('reply-defaults')
  @RequireCap('ticket.reply')
  async replyDefaults(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query('messageId') messageId?: string,
    @Query('mode') mode?: string,
  ) {
    // 12.4: recipients come from the specific message the user hit Reply/Reply-All on
    // (messageId), and `mode=reply` narrows to that message's sender only.
    return this.replies.getDefaults(user, id, {
      messageId: messageId || undefined,
      mode: mode === 'reply' ? 'reply' : 'replyAll',
    });
  }

  @Post('replies')
  @RequireCap('ticket.reply')
  async reply(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = replySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.replies.reply(user, id, parsed.data);
  }

  /** Forward one message of the thread to new recipients (Gmail-style Fwd:). */
  @Post('forward')
  @RequireCap('ticket.reply')
  async forward(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = forwardSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.replies.forward(user, id, parsed.data);
  }

  /** Undo Send (12.9): recall a held reply/forward within the 8s window. */
  @Post('undo-send')
  @RequireCap('ticket.reply')
  async undoSend(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = undoSendSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.replies.undoSend(user, id, parsed.data.outboxId);
  }

  @Post('notes')
  async note(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = noteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.notes.addNote(user, id, parsed.data.body);
  }

  @Put('draft')
  async putDraft(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = draftSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    return this.drafts.put(user, id, parsed.data.kind, {
      body: parsed.data.body,
      recipients: parsed.data.recipients,
    });
  }

  @Get('draft')
  async getDraft(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query('kind') kind?: string,
  ) {
    const k = kindSchema.safeParse(kind);
    if (!k.success) throw new BadRequestException('Invalid kind');
    return this.drafts.get(user, id, k.data);
  }

  @Delete('draft')
  async deleteDraft(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query('kind') kind?: string,
  ) {
    const k = kindSchema.safeParse(kind);
    if (!k.success) throw new BadRequestException('Invalid kind');
    await this.drafts.remove(user, id, k.data);
    return { ok: true };
  }
}
