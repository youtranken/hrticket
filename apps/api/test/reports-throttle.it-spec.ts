import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { AppModule } from '../src/app.module';
import { makeUser } from './factories/user.factory';

/**
 * IT-REPORT-007 — per-user throttle on the heavy report aggregations (M3).
 * `ReportRateLimitGuard` caps a single authenticated user at 20 requests / 10s on
 * `/api/reports/*`, returning 429 past that, so a user cannot loop the full-table
 * aggregates to degrade the DB. The cap is per USER (session), NOT per IP — behind
 * nginx every request shares one proxy IP. Requires Docker; self-skips otherwise.
 */
describe('reports throttle integration', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let ready = false;

  const server = () => app!.getHttpServer();
  const loginCookie = async (email: string): Promise<string[]> => {
    const res = await request(server())
      .post('/api/auth/login')
      .send({ email, password: 'test-password' })
      .expect(201);
    return res.headers['set-cookie'] as unknown as string[];
  };

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();
      ready = true;
    } catch (e) {
      console.warn('[reports throttle IT] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
  });

  it('IT-REPORT-007: the 21st report call in the window → 429; a different user is unaffected', async () => {
    if (!ready) return;
    await makeUser(harness!.db, { projectId: 1, email: 'rl-a@test.local', role: 'admin' });
    await makeUser(harness!.db, { projectId: 1, email: 'rl-b@test.local', role: 'admin' });
    const cookieA = await loginCookie('rl-a@test.local');
    const cookieB = await loginCookie('rl-b@test.local');

    const q = '?from=2026-01-01&to=2026-12-31';
    // The first 20 calls for user A succeed (empty aggregates → 200).
    for (let i = 0; i < 20; i += 1) {
      await request(server())
        .get(`/api/reports/summary${q}`)
        .set('Cookie', cookieA)
        .expect(200);
    }
    // The 21st within the same 10s window is throttled.
    await request(server())
      .get(`/api/reports/summary${q}`)
      .set('Cookie', cookieA)
      .expect(429);

    // Per-user cap: user B still gets through even though A is blocked.
    await request(server())
      .get(`/api/reports/summary${q}`)
      .set('Cookie', cookieB)
      .expect(200);
  });
});
