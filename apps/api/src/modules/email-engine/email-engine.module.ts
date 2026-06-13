import { Module } from '@nestjs/common';
import { PollerService } from './poller.service';

/** Mail subsystem: IMAP poll + (later) parse/threading. Used by the worker. */
@Module({
  providers: [PollerService],
  exports: [PollerService],
})
export class EmailEngineModule {}
