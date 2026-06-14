import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';
import { AdminReminderController } from './admin-reminder.controller';
import { AdminReminderService } from './admin-reminder.service';

/** Admin configuration surface: categories/keywords/auto-assign/tags (4.6) +
 *  reminder config / email templates / test-send (6.4). */
@Module({
  imports: [AuthModule], // SessionGuard + ProjectContextService
  controllers: [AdminConfigController, AdminReminderController],
  providers: [AdminConfigService, AdminReminderService],
})
export class AdminModule {}
