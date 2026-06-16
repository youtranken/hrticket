import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { OtpService } from './otp.service';
import { PasswordResetService } from './password-reset.service';
import { MeService } from './me.service';
import { SessionGuard, SESSION_COOKIE, type AuthedRequest } from './session.guard';
import { CurrentUser } from './current-user.decorator';
import type { SessionUser } from './session.service';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const otpVerifySchema = z.object({ preAuthToken: z.string().min(1), code: z.string().length(6) });
const otpToggleSchema = z.object({ enabled: z.boolean(), password: z.string().min(1) });
const languageSchema = z.object({ language: z.enum(['vi', 'en']) });
const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({ token: z.string().min(1), password: z.string().min(8) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// Public base URL for links in transactional email. Read from config (validated at
// boot, fail-fast on a localhost value in production) — NEVER the request Host header,
// which an attacker can forge to poison the reset link (reset-link poisoning).
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:8080';

function setSessionCookie(res: Response, sid: string): void {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
    path: '/',
  });
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly reset: PasswordResetService,
  ) {}

  @Post('login')
  async login(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid credentials payload');
    const ip = req.ip ?? 'unknown';
    const result = await this.auth.login(parsed.data.email, parsed.data.password, ip);
    if (result.kind === 'otp_required') {
      return { otpRequired: true, preAuthToken: result.preAuthToken };
    }
    setSessionCookie(res, result.sessionId);
    return { otpRequired: false };
  }

  @Post('otp/verify')
  async otpVerify(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const parsed = otpVerifySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid OTP payload');
    const sid = await this.auth.verifyOtp(parsed.data.preAuthToken, parsed.data.code);
    setSessionCookie(res, sid);
    return { ok: true };
  }

  @Post('logout')
  @UseGuards(SessionGuard)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    if (req.sessionId) await this.sessions.revoke(req.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  /** Always 200 (no email enumeration). */
  @Post('forgot')
  async forgot(@Body() body: unknown) {
    const parsed = forgotSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    await this.reset.request(parsed.data.email, APP_BASE_URL);
    return { ok: true };
  }

  @Post('reset')
  async resetPassword(@Body() body: unknown) {
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    const ok = await this.reset.reset(parsed.data.token, parsed.data.password);
    if (!ok) throw new BadRequestException('Liên kết không còn hiệu lực');
    return { ok: true };
  }
}

@Controller('api')
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly auth: AuthService,
    private readonly otp: OtpService,
  ) {}

  @Get('me')
  @UseGuards(SessionGuard)
  async whoami(@CurrentUser() user: SessionUser, @Req() req: AuthedRequest) {
    const xProject = req.header('x-project') ?? undefined;
    return this.me.build(user, xProject);
  }

  @Patch('me/otp')
  @UseGuards(SessionGuard)
  async toggleOtp(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const parsed = otpToggleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    const ok = await this.auth.confirmPassword(user.id, parsed.data.password);
    if (!ok) throw new UnauthorizedException('Mật khẩu không đúng');
    await this.otp.setEnabled(user.id, parsed.data.enabled);
    return { otpEnabled: parsed.data.enabled };
  }

  @Patch('me/language')
  @UseGuards(SessionGuard)
  async setLanguage(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const parsed = languageSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    await this.me.setLanguage(user.id, parsed.data.language);
    return { language: parsed.data.language };
  }

  @Post('me/change-password')
  @UseGuards(SessionGuard)
  async changePassword(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payload');
    const ok = await this.auth.changePassword(
      user.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    if (!ok) throw new UnauthorizedException('Mật khẩu hiện tại không đúng');
    return { ok: true };
  }
}
