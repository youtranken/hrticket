import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { AppModule } from '../src/app.module';
import { makeUser } from './factories/user.factory';

/**
 * Auth integration suite over ONE real DB (one container for the whole file — the
 * `db` singleton binds to the first harness, so a second harness here would be
 * silently ignored). Covers:
 *   IT-AUTH-001 — login/session/lockout/disabled/logout/me
 *   IT-AUTH-006 — /me capabilities + X-Project switching (Story 1.8 AC3)
 * Requires Docker; self-skips otherwise.
 */
describe('auth integration', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let ready = false;

  const server = () => app!.getHttpServer();
  const loginCookie = async (email: string, password = 'test-password'): Promise<string[]> => {
    const res = await request(server())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(201);
    return res.headers['set-cookie'] as unknown as string[];
  };

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true }); // seeds project 1=hris, 2=cnb
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();
      ready = true;
    } catch (e) {
      console.warn('[auth IT] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
  });

  // ── IT-AUTH-001 ────────────────────────────────────────────────────────────
  it('IT-AUTH-001: login ok sets cookie; wrong password 401; /me works; logout revokes', async () => {
    if (!ready) return;
    await makeUser(harness!.db, { projectId: 1, email: 'm@test.local', role: 'member' });

    await request(server())
      .post('/api/auth/login')
      .send({ email: 'm@test.local', password: 'nope' })
      .expect(401);

    const cookie = await loginCookie('m@test.local');
    expect(cookie).toBeDefined();

    const me = await request(server()).get('/api/me').set('Cookie', cookie).expect(200);
    expect(me.body.role).toBe('member');
    expect(Array.isArray(me.body.capabilities)).toBe(true);

    await request(server()).post('/api/auth/logout').set('Cookie', cookie).expect(201);
    await request(server()).get('/api/me').set('Cookie', cookie).expect(401);
  });

  it('IT-AUTH-001: disabled user is rejected with 403', async () => {
    if (!ready) return;
    await makeUser(harness!.db, { projectId: 1, email: 'dis@test.local', disabled: true });
    await request(server())
      .post('/api/auth/login')
      .send({ email: 'dis@test.local', password: 'test-password' })
      .expect(403);
  });

  // ── IT-AUTH-006: /me + X-Project (Story 1.8 AC3) ─────────────────────────────
  it('IT-AUTH-006: SSA sees both projects and defaults to its home project', async () => {
    if (!ready) return;
    await makeUser(harness!.db, { projectId: 1, email: 'ssa6@test.local', role: 'ssa' });
    const cookie = await loginCookie('ssa6@test.local');
    const me = await request(server()).get('/api/me').set('Cookie', cookie).expect(200);
    expect(me.body.role).toBe('ssa');
    expect(me.body.projects).toHaveLength(2);
    expect(me.body.projectKey).toBe('hris'); // home (project 1)
    expect(me.body.capabilities).toContain('config.manage_all');
  });

  it('IT-AUTH-006: SSA may switch project via X-Project header', async () => {
    if (!ready) return;
    const cookie = await loginCookie('ssa6@test.local');
    const me = await request(server())
      .get('/api/me')
      .set('Cookie', cookie)
      .set('X-Project', 'cnb')
      .expect(200);
    expect(me.body.projectKey).toBe('cnb');
    expect(me.body.projectId).toBe(2);
  });

  it('IT-AUTH-006: non-SSA cross-project header → 403; own project → 200', async () => {
    if (!ready) return;
    await makeUser(harness!.db, { projectId: 1, email: 'mem6@test.local', role: 'member' });
    const cookie = await loginCookie('mem6@test.local');
    // member belongs to hris(1) → cnb is cross-project → 403
    await request(server())
      .get('/api/me')
      .set('Cookie', cookie)
      .set('X-Project', 'cnb')
      .expect(403);
    // own project header is allowed; member sees only its home project
    const own = await request(server())
      .get('/api/me')
      .set('Cookie', cookie)
      .set('X-Project', 'hris')
      .expect(200);
    expect(own.body.projects).toHaveLength(1);
  });

  it('IT-AUTH-006: unknown project key → 400', async () => {
    if (!ready) return;
    const cookie = await loginCookie('ssa6@test.local');
    await request(server())
      .get('/api/me')
      .set('Cookie', cookie)
      .set('X-Project', 'nope')
      .expect(400);
  });

  // Runs LAST: it locks the shared source IP (127.0.0.1), which would 429 any
  // login in a later test. A successful login resets the counter, so order matters.
  it('IT-AUTH-001: locks out after repeated failures', async () => {
    if (!ready) return;
    const email = 'lock@test.local';
    for (let i = 0; i < 5; i++) {
      await request(server()).post('/api/auth/login').send({ email, password: 'bad' });
    }
    await request(server()).post('/api/auth/login').send({ email, password: 'bad' }).expect(429);
  });
});
