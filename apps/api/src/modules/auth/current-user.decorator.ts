import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from './session.guard';
import type { SessionUser } from './session.service';

/** Injects the authenticated SessionUser (populated by SessionGuard). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return req.sessionUser!;
  },
);
