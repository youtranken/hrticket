import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CoreModule } from './core.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { TicketsModule } from './modules/tickets/tickets.module';

/** HTTP application module. Feature modules (auth, tickets, …) get added per epic. */
@Module({
  imports: [CoreModule, HealthModule, AuthModule, TicketsModule],
  controllers: [AppController],
})
export class AppModule {}
