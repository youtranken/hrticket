import { Controller, Get, Param } from '@nestjs/common';
import { PublicStatusService } from './public-status.service';

/**
 * Public, NO-AUTH ticket status lookup for requesters (#7). The signed token in the path
 * is the only credential; there is no SessionGuard here on purpose. Returns just a coarse
 * status bucket — never notes, assignees, or thread content.
 */
@Controller('api/public/ticket-status')
export class PublicStatusController {
  constructor(private readonly svc: PublicStatusService) {}

  @Get(':token')
  status(@Param('token') token: string) {
    return this.svc.byToken(token);
  }
}
