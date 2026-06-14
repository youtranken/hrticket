import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ParticipantsController } from './participants.controller';
import { ParticipantsService } from './participants.service';
import { TicketsController } from './tickets.controller';
import { TicketsReadService } from './tickets-read.service';
import { ComposeController } from './compose.controller';
import { ReplyService } from './reply.service';
import { NotesService } from './notes.service';
import { DraftsService } from './drafts.service';
import { TicketAttachmentsController } from './ticket-attachments.controller';
import { UploadService } from './upload.service';
import { TicketTagsController } from './ticket-tags.controller';
import { TicketTagsService } from './ticket-tags.service';
import { AssignmentController } from './assignment.controller';
import { AssignmentService } from './assignment.service';

/**
 * HTTP module for ticket resources: list/detail (2.6) + participant approval (2.3)
 * + compose (reply 3.2 / note 3.4 / draft 3.5) + attachment upload (3.6).
 */
@Module({
  imports: [AuthModule], // SessionGuard
  controllers: [
    TicketsController,
    ParticipantsController,
    ComposeController,
    TicketAttachmentsController,
    TicketTagsController,
    AssignmentController,
  ],
  providers: [
    ParticipantsService,
    TicketsReadService,
    ReplyService,
    NotesService,
    DraftsService,
    UploadService,
    TicketTagsService,
    AssignmentService,
  ],
})
export class TicketsModule {}
