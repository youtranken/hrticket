import { Module } from '@nestjs/common';
import { PollerService } from './poller.service';
import { OutboxSender } from './outbox-sender.service';
import { Mailer } from '../../infra/mail/mailer';

/** Mail subsystem: IMAP poll (inbound) + outbox sender (outbound). Used by the worker. */
@Module({
  providers: [PollerService, OutboxSender, Mailer],
  exports: [PollerService, OutboxSender],
})
export class EmailEngineModule {}
