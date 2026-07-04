import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CapabilitiesModule } from '../capabilities/capabilities.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { TicketsReadService } from '../tickets/tickets-read.service';
import { ReportingService } from '../reporting/reporting.service';
import { AuditService } from '../audit/audit.service';

/**
 * Export module (Story 10.4, FR84 + audit export #55). Provides its own
 * TicketsReadService + ReportingService + AuditService instances (all are
 * dependency-free injectables that talk to the DB via withActor), so export
 * reuses the exact 10.1 filter / 10.3 report / 9.5 audit logic without
 * cross-module coupling.
 */
@Module({
  imports: [AuthModule, CapabilitiesModule], // SessionGuard + ProjectContextService + CapabilityGuard
  controllers: [ExportController],
  providers: [ExportService, TicketsReadService, ReportingService, AuditService],
})
export class ExportModule {}
