import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * IT-INFRA-002 (smoke) — the HTTP app boots and serves the liveness root.
 * The full Testcontainers harness (Postgres + GreenMail) arrives in Story 1.3;
 * this proves the integration runner + Nest bootstrap path work.
 */
describe('IT-INFRA-002: app boots', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET / returns 200 ok', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.body.status).toBe('ok');
  });
});
