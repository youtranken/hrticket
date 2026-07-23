import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import {
  startGreenMail,
  useGreenMailSmtpForHris,
  fetchMailbox,
  resetMail,
  type GreenMail,
} from './helpers/greenmail';
import { AppModule } from '../src/app.module';
import { makeUser } from './factories/user.factory';
import { passwordResetTokens } from '../src/infra/db/schema';

/**
 * IT-AUTH-012 — password-reset anti-abuse cooldown (M2).
 * `POST /api/auth/forgot` must issue at most ONE token + ONE mail per account per
 * cooldown window, so a scripted loop cannot flood the victim's inbox, burn the
 * SMTP relay's quota, or grow `password_reset_tokens` unbounded — while still
 * answering 201 identically whether or not the address exists (no enumeration).
 * Real SMTP sink via GreenMail. Requires Docker; self-skips otherwise.
 */
describe('forgot-password cooldown integration', () => {
  let harness: ItHarness | undefined;
  let gm: GreenMail | undefined;
  let app: INestApplication | undefined;
  let ready = false;

  const server = () => app!.getHttpServer();
  const countTokens = async (userId: string): Promise<number> => {
    const rows = await harness!.db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, userId));
    return rows.length;
  };

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      gm = await startGreenMail();
      useGreenMailSmtpForHris(gm); // reset mail goes out via the direct transactional SMTP
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();
      ready = true;
    } catch (e) {
      console.warn('[forgot IT] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 240000);

  afterAll(async () => {
    if (app) await app.close();
    if (gm) await gm.stop();
    if (harness) await harness.stop();
  });

  it('IT-AUTH-012: five forgot calls in the window mail once; unknown email never mails; all 201', async () => {
    if (!ready) return;
    const u = (await makeUser(harness!.db, { projectId: 1, email: 'forgot@test.local' }))!;
    await resetMail(gm!);

    // Hammer the endpoint for the SAME real address — the abuse pattern M2 fixes.
    for (let i = 0; i < 5; i += 1) {
      await request(server())
        .post('/api/auth/forgot')
        .send({ email: 'forgot@test.local' })
        .expect(201);
    }

    // Despite five calls: exactly ONE token persisted and ONE mail delivered.
    expect(await countTokens(u.id)).toBe(1);
    const mails = await fetchMailbox(gm!, 'forgot@test.local');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('Đặt lại mật khẩu');

    // Enumeration contract intact: an unknown address still returns 201 and mails nothing.
    await request(server())
      .post('/api/auth/forgot')
      .send({ email: 'ghost@test.local' })
      .expect(201);
    expect(await fetchMailbox(gm!, 'ghost@test.local')).toHaveLength(0);
  });
});
