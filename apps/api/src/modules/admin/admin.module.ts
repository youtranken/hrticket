import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CapabilitiesModule } from '../capabilities/capabilities.module';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';
import { AdminReminderController } from './admin-reminder.controller';
import { AdminReminderService } from './admin-reminder.service';
import { AdminBlocklistController } from './admin-blocklist.controller';
import { AdminBlocklistService } from './admin-blocklist.service';
import { AdminAllowlistController } from './admin-allowlist.controller';
import { AdminAllowlistService } from './admin-allowlist.service';
import { AdminMailBombController } from './admin-mailbomb.controller';
import { AdminMailBombService } from './admin-mailbomb.service';
import { AttachmentConfigController } from './attachment-config.controller';
import { AttachmentConfigService } from './attachment-config.service';
import { AdminJunkRulesController } from './admin-junkrules.controller';
import { AdminJunkRulesService } from './admin-junkrules.service';
import { AdminGroupsController } from './admin-groups.controller';
import { AdminGroupsService } from './admin-groups.service';
import { EmailConnectionController } from './email-connection.controller';
import { EmailConnectionService } from './email-connection.service';

/** Admin configuration surface: categories/keywords/auto-assign/tags (4.6) +
 *  reminder config / email templates / test-send (6.4) + blocklist (7.1) +
 *  mail-bomb threshold & held-mail review (7.2) + junk rules (7.3) +
 *  attachment policy (8.4) + category-group membership (9.1). */
@Module({
  imports: [AuthModule, CapabilitiesModule], // SessionGuard + ProjectContextService + CapabilityGuard
  controllers: [
    AdminConfigController,
    AdminReminderController,
    AdminBlocklistController,
    AdminAllowlistController,
    AdminMailBombController,
    AttachmentConfigController,
    AdminJunkRulesController,
    AdminGroupsController,
    EmailConnectionController,
  ],
  providers: [
    AdminConfigService,
    AdminReminderService,
    AdminBlocklistService,
    AdminAllowlistService,
    AdminMailBombService,
    AttachmentConfigService,
    AdminJunkRulesService,
    AdminGroupsService,
    EmailConnectionService,
  ],
})
export class AdminModule {}
