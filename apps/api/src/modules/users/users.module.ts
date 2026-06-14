import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';

/** User self-service + admin user operations beyond auth (Story 4.3 availability). */
@Module({
  imports: [AuthModule], // SessionGuard
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
})
export class UsersModule {}
