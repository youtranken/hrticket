import { Module } from '@nestjs/common';
import { AuthController, MeController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { LockoutService } from './lockout.service';
import { MeService } from './me.service';
import { SessionGuard } from './session.guard';

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, SessionService, LockoutService, MeService, SessionGuard],
  exports: [SessionService, SessionGuard, MeService],
})
export class AuthModule {}
