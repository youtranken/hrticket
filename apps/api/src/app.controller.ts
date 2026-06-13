import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  /** Liveness root — Story 1.1 AC1 (GET / returns 200). Real health lands in Story 1.3. */
  @Get()
  root(): { name: string; status: string } {
    return { name: 'hris-ticket-api', status: 'ok' };
  }

  @Get('api/ping')
  ping(): { pong: true } {
    return { pong: true };
  }
}
