import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
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
    req.sessionUser = user;
    req.sessionId = sid;
    return true;
  }
}
