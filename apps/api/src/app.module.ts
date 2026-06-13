import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CoreModule } from './core.module';
import { HealthModule } from './modules/health/health.module';

/** HTTP application module. Feature modules (auth, tickets, …) get added per epic. */
@Module({
  imports: [CoreModule, HealthModule],
  controllers: [AppController],
})
export class AppModule {}
