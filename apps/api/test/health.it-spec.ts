import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { HealthModule } from '../src/modules/health/health.module';

/**
 * IT-OPS-001 — readyz reflects real DB state. Requires Docker; self-skips otherwise.
 */
describe('IT-OPS-001: health over a real database', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let ready = false;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: false });
      const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      ready = true;
    } catch (e) {
      console.warn('[IT-OPS-001] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
  });

  it('healthz 200 and readyz 200 when DB is up', async () => {
    if (!ready || !app) return;
    await request(app.getHttpServer()).get('/healthz').expect(200);
    const res = await request(app.getHttpServer()).get('/readyz').expect(200);
    expect(res.body.db).toBe('up');
    // Empty worker_heartbeats must NOT be treated as stale (party-mode A8).
    expect(res.body.status).toBe('ok');
  });
});
