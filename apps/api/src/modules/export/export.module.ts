import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { TicketsReadService } from '../tickets/tickets-read.service';
import { ReportingService } from '../reporting/reporting.service';

/**
 * Export module (Story 10.4, FR84). Provides its own TicketsReadService +
 * ReportingService instances (both are dependency-free injectables that talk to
 * the DB via withActor), so export reuses the exact 10.1 filter and 10.3 report
 * logic without cross-module coupling.
 */
@Module({
  imports: [AuthModule], // SessionGuard + ProjectContextService
  controllers: [ExportController],
  providers: [ExportService, TicketsReadService, ReportingService],
})
export class ExportModule {}
