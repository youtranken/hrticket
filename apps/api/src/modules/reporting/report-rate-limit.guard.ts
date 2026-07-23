import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/session.guard';

/**
 * Lightweight in-memory per-user throttle for the heavy report aggregations (M3).
 * Each `/api/reports/*` call runs several full-table aggregate scans over `tickets`;
 * without a cap an authenticated user could loop them to degrade the DB. Bounds a
 * single user to `max` requests per `windowMs`, returning 429 past that.
 *
 * In-memory (per-process) is sufficient because prod runs a single api container
 * (docker-compose.prod). If the api is ever scaled out, move the counter to the DB
 * or a shared store so the window is enforced globally.
 */
@Injectable()
export class ReportRateLimitGuard implements CanActivate {
  private readonly windowMs = 10_000;
  private readonly max = 20;
  private readonly hits = new Map<string, number[]>();

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    // Key on the authenticated user (SessionGuard runs first and sets sessionUser),
    // NOT req.ip — behind nginx every request would share the one proxy IP.
    const key = req.sessionUser?.id ?? req.ip ?? 'anon';
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      throw new HttpException(
        'Too many report requests, slow down',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
