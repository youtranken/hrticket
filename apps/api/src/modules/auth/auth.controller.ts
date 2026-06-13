import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { MeService } from './me.service';
import { SessionGuard, SESSION_COOKIE, type AuthedRequest } from './session.guard';
import { CurrentUser } from './current-user.decorator';
import type { SessionUser } from './session.service';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

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
    private readonly me: MeService,
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
      return { otpRequired: true, userId: result.userId };
    }
    setSessionCookie(res, result.sessionId);
    return { otpRequired: false };
  }

  @Post('logout')
  @UseGuards(SessionGuard)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    if (req.sessionId) await this.sessions.revoke(req.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}

@Controller('api')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('me')
  @UseGuards(SessionGuard)
  async whoami(@CurrentUser() user: SessionUser) {
    return this.me.build(user);
  }
}
