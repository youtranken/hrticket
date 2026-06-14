import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';

/** Admin configuration surface (Story 4.6): categories, keywords, auto-assign, tags. */
@Module({
  imports: [AuthModule], // SessionGuard + ProjectContextService
  controllers: [AdminConfigController],
  providers: [AdminConfigService],
})
export class AdminModule {}
