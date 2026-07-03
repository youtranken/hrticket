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
  type GreenMail,
} from './helpers/greenmail';
import { AppModule } from '../src/app.module';
import { makeUser } from './factories/user.factory';
import { users } from '../src/infra/db/schema';

/**
 * IT-AUTH-010 — OTP login resend (UX P0 #11, "Gửi lại mã").
 * Real SMTP sink (GreenMail): login with an otp-enabled user yields a pre-auth
 * token; POST /auth/otp/resend re-issues a fresh code + fresh token, garbage
 * tokens are rejected, and the per-window issue cap (5 codes / 15 min, summed
 * across login + resends) returns 429 so a stolen pre-auth token cannot
 * mail-bomb the user's inbox. Requires Docker; self-skips otherwise.
 */
describe('OTP resend integration', () => {
  let harness: ItHarness | undefined;
  let gm: GreenMail | undefined;
  let app: INestApplication | undefined;
  let ready = false;

  const server = () => app!.getHttpServer();

  const otpUser = async (email: string) => {
    const row = (await makeUser(harness!.db, { projectId: 1, email }))!;
    await harness!.db.update(users).set({ otpEnabled: true }).where(eq(users.id, row.id));
    return row;
  };

  /** Password step for an otp-enabled user — returns the pre-auth token. */
  const loginForOtp = async (email: string): Promise<string> => {
    const res = await request(server())
      .post('/api/auth/login')
      .send({ email, password: 'test-password' })
      .expect(201);
    expect(res.body.otpRequired).toBe(true);
    expect(typeof res.body.preAuthToken).toBe('string');
    return res.body.preAuthToken as string;
  };

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      gm = await startGreenMail();
      useGreenMailSmtpForHris(gm); // OTP mail goes out via direct SMTP (not the outbox)
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();
      ready = true;
    } catch (e) {
      console.warn('[otp IT] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 240000);

  afterAll(async () => {
    if (app) await app.close();
    if (gm) await gm.stop();
    if (harness) await harness.stop();
  });

  it('IT-AUTH-010: resend issues a fresh code + fresh token; garbage token → 401', async () => {
    if (!ready) return;
    await otpUser('otp1@test.local');
    const tok = await loginForOtp('otp1@test.local'); // code #1 mailed

    const res = await request(server())
      .post('/api/auth/otp/resend')
      .send({ preAuthToken: tok })
      .expect(201);
    expect(typeof res.body.preAuthToken).toBe('string');
    expect(res.body.preAuthToken).not.toBe(tok); // fresh token, old code superseded

    // Both OTP mails actually landed in the user's mailbox (login + resend).
    const mails = await fetchMailbox(gm!, 'otp1@test.local');
    expect(mails.length).toBeGreaterThanOrEqual(2);

    await request(server())
      .post('/api/auth/otp/resend')
      .send({ preAuthToken: 'garbage' })
      .expect(401);
  });

  it('IT-AUTH-010: issue cap — 5 codes per window, the next resend → 429', async () => {
    if (!ready) return;
    await otpUser('otp2@test.local');
    let live = await loginForOtp('otp2@test.local'); // code #1
    for (let i = 0; i < 4; i += 1) {
      // codes #2..#5 — each resend returns the token the NEXT call must use
      const res = await request(server())
        .post('/api/auth/otp/resend')
        .send({ preAuthToken: live })
        .expect(201);
      live = res.body.preAuthToken as string;
    }
    await request(server())
      .post('/api/auth/otp/resend')
      .send({ preAuthToken: live })
      .expect(429);
  });
});
