import { Module } from '@nestjs/common';
import { PublicStatusController } from './public-status.controller';
import { PublicStatusService } from './public-status.service';

/** No-auth, token-signed endpoints reachable by external requesters (#7). */
@Module({
  controllers: [PublicStatusController],
  providers: [PublicStatusService],
})
export class PublicModule {}
