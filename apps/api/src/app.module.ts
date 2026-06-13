import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CoreModule } from './core.module';

/** HTTP application module. Feature modules (auth, tickets, …) get added per epic. */
@Module({
  imports: [CoreModule],
  controllers: [AppController],
})
export class AppModule {}
