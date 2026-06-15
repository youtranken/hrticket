import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportingController } from './reporting.controller';
import { ReportingService } from './reporting.service';

/** Report dashboard (Story 10.3, FR83): by-time / by-category / by-staff. */
@Module({
  imports: [AuthModule], // SessionGuard + ProjectContextService
  controllers: [ReportingController],
  providers: [ReportingService],
})
export class ReportingModule {}
