import { Module } from '@nestjs/common';
import { AuthController, MeController } from './auth.controller';
import { AdminUsersController } from './admin-users.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { LockoutService } from './lockout.service';
import { OtpService } from './otp.service';
import { PasswordResetService } from './password-reset.service';
import { RescueService } from './rescue.service';
import { MeService } from './me.service';
import { SessionGuard } from './session.guard';
import { Mailer } from '../../infra/mail/mailer';

@Module({
  controllers: [AuthController, MeController, AdminUsersController],
  providers: [
    AuthService,
    SessionService,
    LockoutService,
    OtpService,
    PasswordResetService,
    RescueService,
    MeService,
    SessionGuard,
    Mailer,
  ],
  exports: [SessionService, SessionGuard, MeService, Mailer],
})
export class AuthModule {}
