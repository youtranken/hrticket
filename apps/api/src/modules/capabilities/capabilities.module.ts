import { Module } from '@nestjs/common';
import { CapabilitiesService } from './capabilities.service';
import { CapabilityGuard } from './capability.guard';

/**
 * Leaf module (imports nothing) so every feature module — including AuthModule,
 * which SsaModule itself imports — can use CapabilityGuard without a DI cycle.
 */
@Module({
  providers: [CapabilitiesService, CapabilityGuard],
  exports: [CapabilitiesService, CapabilityGuard],
})
export class CapabilitiesModule {}
