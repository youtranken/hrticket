import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { UploadService } from '../src/modules/tickets/upload.service';
import { FilesService } from '../src/modules/files/files.service';
import { signFileToken, FILE_TOKEN_TTL_MS } from '../src/infra/crypto/signed-url';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { tickets, projectSettings, users } from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');
const EXE = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(64, 0x90)]);

/**
 * IT-UPLOAD-001..003 + IT-RENDER-002 (serve) — Stories 3.6/3.7. Two-layer upload
 * gate (magic bytes + soft cap) and signed-URL file serving. Needs Docker; self-skips.
 */
describe('IT-UPLOAD/FILES: upload gates + signed serve', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  let ssa: SessionUser;
  let storageRoot: string;
  const uploads = new UploadService();
  const files = new FilesService();

  beforeAll(async () => {
    storageRoot = path.join(os.tmpdir(), `hris-it-storage-${process.pid}`);
    process.env.ATTACHMENT_STORAGE_ROOT = storageRoot;
    try {
      harness = await startHarness({ seed: true });
      const [u] = await harness.db.select().from(users).where(eq(users.email, 'ssa@pmh.com.vn'));
      ssa = {
        id: u!.id,
        email: u!.email,
        name: u!.name,
        role: 'ssa',
        projectId: 1,
        disabled: false,
        mustChangePassword: false,
      };
      ready = true;
    } catch (e) {
      console.warn('[IT-UPLOAD] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  let ticketId: string;
  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.update(projectSettings).set({ attachmentCapMb: 50 }).where(eq(projectSettings.projectId, 1));
    ticketId = await withActor(systemActor, async (tx) => {
      const [t] = await tx
        .insert(tickets)
        .values({
          projectId: 1,
          ticketCode: `#${String(Math.floor(Math.random() * 90000) + 10000)}`,
          subject: 'Upload test',
          requesterEmail: 'req@x.com',
          mailbox: 'hris@test.local',
          status: 'open',
        })
        .returning({ id: tickets.id });
      return t!.id;
    });
  });

  it('IT-UPLOAD-001: valid pdf is stored on disk + DB; serve returns its bytes', async () => {
    if (!ready) return;
    const res = await uploads.store(ssa, ticketId, { fileName: 'payslip.pdf', content: PDF });
    expect(res.status).toBe('stored');
    expect(res.mimeType).toBe('application/pdf');

    const served = await files.serve(ssa, res.id, signFileToken(res.id, ssa.id));
    expect(served.fileName).toBe('payslip.pdf');
    expect(served.buffer.equals(PDF)).toBe(true);
  });

  it('IT-UPLOAD-002: exe rejected; .pdf name with exe bytes rejected (magic beats extension)', async () => {
    if (!ready) return;
    await expect(uploads.store(ssa, ticketId, { fileName: 'tool.exe', content: EXE })).rejects.toMatchObject({
      status: 422,
    });
    await expect(uploads.store(ssa, ticketId, { fileName: 'fake.pdf', content: EXE })).rejects.toMatchObject({
      status: 422,
    });
  });

  it('IT-UPLOAD-003: soft cap is config-driven and rejects before disk write', async () => {
    if (!ready) return;
    await harness!.db.update(projectSettings).set({ attachmentCapMb: 0 }).where(eq(projectSettings.projectId, 1));
    await expect(uploads.store(ssa, ticketId, { fileName: 'p.pdf', content: PDF })).rejects.toMatchObject({
      status: 413,
    });
    // Raise the cap → the same file now uploads (AC3).
    await harness!.db.update(projectSettings).set({ attachmentCapMb: 50 }).where(eq(projectSettings.projectId, 1));
    const ok = await uploads.store(ssa, ticketId, { fileName: 'p.pdf', content: PDF });
    expect(ok.status).toBe('stored');
  });

  it('IT-RENDER-002: serve rejects a bad or expired token (403)', async () => {
    if (!ready) return;
    const res = await uploads.store(ssa, ticketId, { fileName: 'x.pdf', content: PDF });
    await expect(files.serve(ssa, res.id, 'not-a-valid-token')).rejects.toMatchObject({ status: 403 });
    const expired = signFileToken(res.id, ssa.id, Date.now() - FILE_TOKEN_TTL_MS - 1000);
    await expect(files.serve(ssa, res.id, expired)).rejects.toMatchObject({ status: 403 });
  });
});
