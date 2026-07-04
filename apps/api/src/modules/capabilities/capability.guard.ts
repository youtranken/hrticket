import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@hris/shared';
import type { AuthedRequest } from '../auth/session.guard';
import type { Capability } from './capability-catalog';
import { CapabilitiesService } from './capabilities.service';

export const REQUIRE_CAP_KEY = 'require_capability';

/**
 * Declares the capability an endpoint (or a whole controller) requires. Several
 * capabilities mean ANY-OF — e.g. config endpoints accept `config.manage` (Admin)
 * OR `config.manage_all` (SSA, locked ON).
 */
export const RequireCap = (...caps: [Capability, ...Capability[]]) =>
  SetMetadata(REQUIRE_CAP_KEY, caps);

/**
 * Enforces the SSA-editable role × capability matrix at the API (closes the FR55
 * gap where the matrix only drove menu visibility). Runs AFTER SessionGuard —
 * always list it second in `@UseGuards(SessionGuard, CapabilityGuard)`. A role
 * whose capability is toggled OFF gets 403 CAPABILITY_DISABLED within one request
 * (the editor busts the read cache on write). Fine-grained rules (assignee-first
 * reply, group scope, claim-over rank) still live in the services — a capability
 * is NECESSARY, never sufficient.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly caps: CapabilitiesService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Capability[] | undefined>(REQUIRE_CAP_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().sessionUser;
    if (!user) throw new UnauthorizedException(); // SessionGuard must run first
    if (!(await this.caps.hasAny(user.role, required))) {
      throw new ForbiddenException(ErrorCode.CAPABILITY_DISABLED);
    }
    return true;
  }
}
