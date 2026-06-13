import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { DbHealthService, ReadinessReport } from './db-health.service';

function controllerWith(report: ReadinessReport): HealthController {
  return new HealthController({ check: async () => report } as DbHealthService);
}

describe('HealthController', () => {
  it('healthz is always 200 ok', () => {
    expect(controllerWith({} as ReadinessReport).healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns ok when DB up and worker fresh', async () => {
    const res = await controllerWith({
      ok: true,
      db: 'up',
      outboxPending: 0,
      workerStale: false,
    }).readyz();
    expect(res.status).toBe('ok');
  });

  it('readyz returns degraded when worker heartbeats are stale', async () => {
    const res = await controllerWith({
      ok: true,
      db: 'up',
      outboxPending: 3,
      workerStale: true,
    }).readyz();
    expect(res.status).toBe('degraded');
  });

  it('readyz throws 503 when DB is down', async () => {
    await expect(
      controllerWith({ ok: false, db: 'down', outboxPending: null, workerStale: false }).readyz(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
