import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DbHealthService } from './db-health.service';

@Controller()
export class HealthController {
  constructor(private readonly dbHealth: DbHealthService) {}

  /** Liveness — never touches the DB; 200 while the process is alive. */
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness — DB ping + outbox lag + worker heartbeats. 503 when DB is down. */
  @Get('readyz')
  async readyz() {
    const report = await this.dbHealth.check();
    if (!report.ok) {
      throw new ServiceUnavailableException({ status: 'down', ...report });
    }
    return { status: report.workerStale ? 'degraded' : 'ok', ...report };
  }
}
