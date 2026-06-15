import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JunkController } from './junk.controller';
import { JunkService } from './junk.service';

/** Junk tab (Story 7.3): RLS-scoped list of is_junk tickets + "Không phải rác" release. */
@Module({
  imports: [AuthModule], // SessionGuard
  controllers: [JunkController],
  providers: [JunkService],
})
export class JunkModule {}
