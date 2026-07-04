import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CapabilitiesModule } from '../capabilities/capabilities.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** Story 9.5 — read side of the audit log + sensitive view-log (the write side is
 *  `infra/audit/writeAudit`, called in-tx across every epic). */
@Module({
  imports: [AuthModule, CapabilitiesModule], // SessionGuard + ProjectContextService + CapabilityGuard
  controllers: [AuditController],
  providers: [AuditService],
})
export class AuditModule {}
