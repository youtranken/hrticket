import { Module } from '@nestjs/common';
import { AuthController, MeController } from './auth.controller';
import { AdminUsersController } from './admin-users.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { LockoutService } from './lockout.service';
import { OtpService } from './otp.service';
import { PasswordResetService } from './password-reset.service';
import { RescueService } from './rescue.service';
import { AdminUsersService } from './admin-users.service';
import { MeService } from './me.service';
import { ProjectContextService } from './project-context.service';
import { SessionGuard } from './session.guard';
import { Mailer } from '../../infra/mail/mailer';
import { CapabilitiesModule } from '../capabilities/capabilities.module';

@Module({
  imports: [CapabilitiesModule], // CapabilityGuard for the user-admin surface
  controllers: [AuthController, MeController, AdminUsersController],
  providers: [
    AuthService,
    SessionService,
    LockoutService,
    OtpService,
    PasswordResetService,
    RescueService,
    AdminUsersService,
    MeService,
    ProjectContextService,
    SessionGuard,
    Mailer,
  ],
  exports: [SessionService, SessionGuard, MeService, ProjectContextService, Mailer],
})
export class AuthModule {}
