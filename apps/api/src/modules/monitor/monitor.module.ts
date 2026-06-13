import { Module } from '@nestjs/common';
import { MonitorService } from './monitor.service';
import { Mailer } from '../../infra/mail/mailer';

/** Worker-liveness monitor — runs in the API process (NFR18). */
@Module({
  providers: [MonitorService, Mailer],
  exports: [MonitorService],
})
export class MonitorModule {}
