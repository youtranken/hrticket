import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CoreModule } from './core.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { FilesModule } from './modules/files/files.module';
import { MonitorModule } from './modules/monitor/monitor.module';
import { UsersModule } from './modules/users/users.module';
import { AdminModule } from './modules/admin/admin.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { JunkModule } from './modules/junk/junk.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { ExportModule } from './modules/export/export.module';

/** HTTP application module. Feature modules (auth, tickets, …) get added per epic. */
@Module({
  imports: [
    CoreModule,
    HealthModule,
    AuthModule,
    TicketsModule,
    FilesModule,
    MonitorModule,
    UsersModule,
    AdminModule,
    NotificationsModule,
    JunkModule,
    ReportingModule,
    ExportModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
