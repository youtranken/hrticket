import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DbHealthService } from './db-health.service';

@Module({
  controllers: [HealthController],
  providers: [DbHealthService],
})
export class HealthModule {}
