import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CapabilitiesModule } from '../capabilities/capabilities.module';
import { RoleCapabilitiesController } from './role-capabilities.controller';
import { RoleCapabilitiesService } from './role-capabilities.service';

/** SSA-only administration: runtime role-capability matrix editor (Story 9.4). */
@Module({
  imports: [AuthModule, CapabilitiesModule], // SessionGuard + shared capability cache
  controllers: [RoleCapabilitiesController],
  providers: [RoleCapabilitiesService],
  exports: [RoleCapabilitiesService],
})
export class SsaModule {}
