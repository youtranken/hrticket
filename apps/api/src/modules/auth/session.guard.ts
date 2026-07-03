import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ErrorCode } from '@hris/shared';
import { SessionService, type SessionUser } from './session.service';

export const SESSION_COOKIE = 'hris_sid';

export interface AuthedRequest extends Request {
  sessionUser?: SessionUser;
  sessionId?: string;
}

/** Authenticates a request from the session cookie and attaches the user. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const sid = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!sid) throw new UnauthorizedException();
    const user = await this.sessions.resolve(sid);
    if (!user) throw new UnauthorizedException();
    // Forced password change (temp / admin-reset credential): the session is valid but
    // the user must NOT drive the API until the password is changed — the FE screen is
    // only a UX gate, so enforce it here too. Allow only what the change flow itself needs.
    if (user.mustChangePassword) {
      const p = req.path;
      const allowed =
        (req.method === 'GET' && p === '/api/me') ||
        (req.method === 'POST' && p === '/api/me/change-password') ||
        (req.method === 'POST' && p === '/api/auth/logout');
      if (!allowed) throw new ForbiddenException(ErrorCode.PASSWORD_CHANGE_REQUIRED);
    }
    req.sessionUser = user;
    req.sessionId = sid;
    return true;
  }
}
