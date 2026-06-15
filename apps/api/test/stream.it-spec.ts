import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { AppModule } from '../src/app.module';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { signFileToken, FILE_TOKEN_TTL_MS } from '../src/infra/crypto/signed-url';
import { storagePathFor, writeFile } from '../src/infra/storage/fs-storage';
import * as fsStorage from '../src/infra/storage/fs-storage';
import { makeUser } from './factories/user.factory';
import { tickets, attachments } from '../src/infra/db/schema';

/**
 * IT-STREAM-001..003 — Story 8.1. HTTP Range streaming + signed-URL serve over the
 * REAL HTTP endpoint (supertest). Needs Docker; self-skips.
 *
 *  001 — Range matrix (head/middle/tail/suffix/open-ended; no-range full 200; bad → 416)
 *  002 — signed-URL is the only key (tamper / expiry / wrong attachment → 403) +
 *        UTF-8 download filename (RFC 5987) with intact bytes
 *  003 — serve streams via fs.createReadStream with start/end (no full-file buffer)
 */
describe('IT-STREAM: HTTP Range + signed serve', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let ready = false;
  let storageRoot = '';

  const HRIS = 1;
  // 256 deterministic bytes (value === index mod 256) so any slice is exactly assertable.
  const FILE_SIZE = 256;
  const DATA = Buffer.from(Array.from({ length: FILE_SIZE }, (_, i) => i % 256));

  let cookie: string[];
  let attId = '';
  let token: string;
  let userId = '';

  const server = () => app!.getHttpServer();

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hris-stream-'));
    process.env.ATTACHMENT_STORAGE_ROOT = storageRoot;
    try {
      harness = await startHarness({ seed: true });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();

      // A dedicated SSA user (password = test-password via the factory). SSA sees every
      // ticket (RLS grants both projects) — keeps the test about streaming, not
      // visibility (8.3 covers the permission matrix).
      const ssa = await makeUser(harness.db, { projectId: HRIS, role: 'ssa', email: 'stream-ssa@test.local' });
      userId = ssa!.id;
      const res = await request(server())
        .post('/api/auth/login')
        .send({ email: 'stream-ssa@test.local', password: 'test-password' })
        .expect(201);
      cookie = res.headers['set-cookie'] as unknown as string[];

      // A stored attachment with a Vietnamese original name and a known byte payload.
      const when = new Date();
      const relPath = storagePathFor(HRIS, 'stream-uuid-aaaa', when);
      await writeFile(relPath, DATA);
      attId = await withActor(systemActor, async (tx) => {
        const [t] = await tx
          .insert(tickets)
          .values({
            projectId: HRIS,
            ticketCode: '#08001',
            subject: 'stream',
            requesterEmail: 'a@x.com',
            mailbox: 'hris@test.local',
            status: 'open',
          })
          .returning({ id: tickets.id });
        const [a] = await tx
          .insert(attachments)
          .values({
            ticketId: t!.id,
            fileName: 'Đơn xin nghỉ phép.pdf',
            mimeType: 'audio/mpeg', // pretend mp3 to assert Accept-Ranges/206 for media
            size: FILE_SIZE,
            storagePath: relPath,
            status: 'stored',
          })
          .returning({ id: attachments.id });
        return a!.id;
      });
      token = signFileToken(attId, userId);
      ready = true;
    } catch (e) {
      console.warn('[IT-STREAM] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
    if (storageRoot) await fs.rm(storageRoot, { recursive: true, force: true });
  });

  // ── IT-STREAM-001 — Range matrix ────────────────────────────────────────────
  it('IT-STREAM-001: no Range → 200 full + Accept-Ranges', async () => {
    if (!ready) return;
    const res = await request(server())
      .get(`/api/files/${attId}`)
      .query({ token })
      .set('Cookie', cookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(FILE_SIZE));
    expect((res.body as Buffer).equals(DATA)).toBe(true);
  });

  const fetchRange = async (range: string) =>
    request(server())
      .get(`/api/files/${attId}`)
      .query({ token })
      .set('Cookie', cookie)
      .set('Range', range)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  it('IT-STREAM-001: head/middle/tail/open-ended/suffix → 206 + exact bytes', async () => {
    if (!ready) return;
    // head
    let res = await fetchRange('bytes=0-9');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-9/${FILE_SIZE}`);
    expect(res.headers['content-length']).toBe('10');
    expect((res.body as Buffer).equals(DATA.subarray(0, 10))).toBe(true);

    // middle
    res = await fetchRange('bytes=100-149');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100-149/${FILE_SIZE}`);
    expect((res.body as Buffer).equals(DATA.subarray(100, 150))).toBe(true);

    // open-ended → to EOF
    res = await fetchRange('bytes=200-');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 200-255/${FILE_SIZE}`);
    expect((res.body as Buffer).equals(DATA.subarray(200))).toBe(true);

    // suffix → final N bytes
    res = await fetchRange('bytes=-16');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 240-255/${FILE_SIZE}`);
    expect((res.body as Buffer).equals(DATA.subarray(240))).toBe(true);
  });

  it('IT-STREAM-001: bad/unsatisfiable Range → 416 + Content-Range */size', async () => {
    if (!ready) return;
    const res = await fetchRange('bytes=500-600');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${FILE_SIZE}`);
  });

  it('IT-STREAM-001: multi-range falls back to a full 200', async () => {
    if (!ready) return;
    const res = await fetchRange('bytes=0-9,20-29');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(FILE_SIZE));
  });

  // ── IT-STREAM-002 — signed URL is the only key + UTF-8 download ──────────────
  it('IT-STREAM-002: tampered / expired / wrong-attachment token → 403', async () => {
    if (!ready) return;
    // (a) tamper one char
    const tampered = token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    await request(server()).get(`/api/files/${attId}`).query({ token: tampered }).set('Cookie', cookie).expect(403);
    // (b) expired TTL
    const expired = signFileToken(attId, userId, Date.now() - FILE_TOKEN_TTL_MS - 1000);
    await request(server()).get(`/api/files/${attId}`).query({ token: expired }).set('Cookie', cookie).expect(403);
    // (c) a token minted for a DIFFERENT attachment id
    const otherToken = signFileToken('11111111-1111-1111-1111-111111111111', userId);
    await request(server()).get(`/api/files/${attId}`).query({ token: otherToken }).set('Cookie', cookie).expect(403);
    // re-mint → works again
    await request(server())
      .get(`/api/files/${attId}`)
      .query({ token: signFileToken(attId, userId) })
      .set('Cookie', cookie)
      .expect(200);
  });

  it('IT-STREAM-002: ?dl=1 → attachment with RFC 5987 UTF-8 filename + intact bytes', async () => {
    if (!ready) return;
    const res = await request(server())
      .get(`/api/files/${attId}`)
      .query({ token: signFileToken(attId, userId), dl: '1' })
      .set('Cookie', cookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const cd = res.headers['content-disposition'] as string;
    expect(cd.startsWith('attachment;')).toBe(true);
    // UTF-8'' + percent-encoded original name (RFC 5987). Decodes back to the original.
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
    const encoded = m?.[1];
    expect(encoded).toBeTruthy();
    expect(decodeURIComponent(encoded!)).toBe('Đơn xin nghỉ phép.pdf');
    // checksum intact
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect(sha(res.body as Buffer)).toBe(sha(DATA));
  });

  it('IT-STREAM-002: missing token → 403; access-url mint returns a working URL', async () => {
    if (!ready) return;
    await request(server()).get(`/api/files/${attId}`).set('Cookie', cookie).expect(403);
    const mint = await request(server())
      .post(`/api/files/${attId}/access-url`)
      .set('Cookie', cookie)
      .expect(201);
    expect(mint.body.url).toMatch(new RegExp(`^/api/files/${attId}\\?token=`));
    // the minted relative URL works end-to-end
    await request(server()).get(mint.body.url).set('Cookie', cookie).expect(200);
  });

  // ── IT-STREAM-003 — streams, never buffers whole file ───────────────────────
  it('IT-STREAM-003: serve uses fs.createReadStream with start/end (no full buffer)', async () => {
    if (!ready) return;
    const spy = jest.spyOn(fsStorage, 'createReadStreamFor');
    await fetchRange('bytes=100-149');
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some(([, range]) => range?.start === 100 && range?.end === 149)).toBe(true);
    spy.mockRestore();
  });
});
