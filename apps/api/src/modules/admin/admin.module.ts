import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';
import { AdminReminderController } from './admin-reminder.controller';
import { AdminReminderService } from './admin-reminder.service';
import { AdminBlocklistController } from './admin-blocklist.controller';
import { AdminBlocklistService } from './admin-blocklist.service';
import { AdminMailBombController } from './admin-mailbomb.controller';
import { AdminMailBombService } from './admin-mailbomb.service';
import { AttachmentConfigController } from './attachment-config.controller';
import { AttachmentConfigService } from './attachment-config.service';
import { AdminJunkRulesController } from './admin-junkrules.controller';
import { AdminJunkRulesService } from './admin-junkrules.service';

/** Admin configuration surface: categories/keywords/auto-assign/tags (4.6) +
 *  reminder config / email templates / test-send (6.4) + blocklist (7.1) +
 *  mail-bomb threshold & held-mail review (7.2) + junk rules (7.3) +
 *  attachment policy (8.4). */
@Module({
  imports: [AuthModule], // SessionGuard + ProjectContextService
  controllers: [
    AdminConfigController,
    AdminReminderController,
    AdminBlocklistController,
    AdminMailBombController,
    AttachmentConfigController,
    AdminJunkRulesController,
  ],
  providers: [
    AdminConfigService,
    AdminReminderService,
    AdminBlocklistService,
    AdminMailBombService,
    AttachmentConfigService,
    AdminJunkRulesService,
  ],
})
export class AdminModule {}
