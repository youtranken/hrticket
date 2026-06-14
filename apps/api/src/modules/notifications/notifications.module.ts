import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/** In-app notification bell (Story 6.1). The emit() write path is a free function
 *  (notifications/emit.ts) used inside other modules' transactions. */
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
