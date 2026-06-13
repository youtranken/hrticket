import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { AppModule } from '../src/app.module';
import { makeUser } from './factories/user.factory';

/**
 * IT-AUTH-001 — login/session/lockout/disabled/logout/me over a real DB.
 * Requires Docker; self-skips otherwise.
 */
describe('IT-AUTH-001: authentication', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let ready = false;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true }); // seeds projects/categories
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();
      ready = true;
    } catch (e) {
      console.warn('[IT-AUTH-001] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
  });

  it('login ok sets cookie; wrong password 401; /me works; logout revokes', async () => {
    if (!ready || !app || !harness) return;
    const server = app.getHttpServer();
    await makeUser(harness.db, { projectId: 1, email: 'm@test.local', role: 'member' });

    // wrong password → 401 generic
    await request(server)
      .post('/api/auth/login')
      .send({ email: 'm@test.local', password: 'nope' })
      .expect(401);

    // correct → 200 + cookie
    const ok = await request(server)
      .post('/api/auth/login')
      .send({ email: 'm@test.local', password: 'test-password' })
      .expect(201);
    const cookie = ok.headers['set-cookie'];
    expect(cookie).toBeDefined();

    // /me with cookie
    const me = await request(server).get('/api/me').set('Cookie', cookie).expect(200);
    expect(me.body.role).toBe('member');
    expect(Array.isArray(me.body.capabilities)).toBe(true);

    // logout → cookie cleared, /me now 401
    await request(server).post('/api/auth/logout').set('Cookie', cookie).expect(201);
    await request(server).get('/api/me').set('Cookie', cookie).expect(401);
  });

  it('disabled user is rejected with 403', async () => {
    if (!ready || !app || !harness) return;
    await makeUser(harness.db, { projectId: 1, email: 'dis@test.local', disabled: true });
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'dis@test.local', password: 'test-password' })
      .expect(403);
  });

  it('locks out after repeated failures', async () => {
    if (!ready || !app) return;
    const server = app.getHttpServer();
    const email = 'lock@test.local';
    for (let i = 0; i < 5; i++) {
      await request(server).post('/api/auth/login').send({ email, password: 'bad' });
    }
    // next attempt is locked → 429 (even if it were correct)
    await request(server)
      .post('/api/auth/login')
      .send({ email, password: 'bad' })
      .expect(429);
  });
});
