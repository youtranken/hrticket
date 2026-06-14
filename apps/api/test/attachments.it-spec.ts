import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer';
import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { seedInbox } from './helpers/mail-raw';
import { IntakeService } from '../src/modules/intake/intake.service';
import { repairAttachments } from '../src/modules/intake/attachment-repair';
import { storageRoot, writeFile } from '../src/infra/storage/fs-storage';
import {
  inboxMessages,
  tickets,
  ticketMessages,
  participants,
  attachments,
  projectCounters,
  outbox,
  ticketTags,
} from '../src/infra/db/schema';

interface Att {
  filename: string;
  content: Buffer;
}

function buildRaw(messageId: string, atts: Att[]): Promise<string> {
  return new Promise((resolve, reject) => {
    new MailComposer({
      from: 'a@x.com',
      to: 'hris@test.local',
      subject: 'with files',
      text: 'see attached',
      messageId,
      attachments: atts.map((a) => ({ filename: a.filename, content: a.content })),
    })
      .compile()
      .build((err, msg) => (err ? reject(err) : resolve(msg.toString('utf8'))));
  });
}

// Real magic-byte payloads.
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(16, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(16, 0x00)]); // PE executable

describe('IT-FILE: attachment ingest', () => {
  let harness: ItHarness | undefined;
  let intake: IntakeService;
  let ready = false;
  let tmpRoot = '';
  const HRIS = 1;
  const BOX = 'hris@test.local';

  beforeAll(async () => {
    try {
      tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hris-att-'));
      process.env.ATTACHMENT_STORAGE_ROOT = tmpRoot;
      harness = await startHarness({ seed: true });
      intake = new IntakeService();
      ready = true;
    } catch (e) {
      console.warn('[IT-FILE] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (harness) await harness.stop();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(attachments);
      await harness!.db.delete(participants);
      await harness!.db.delete(ticketMessages);
      await harness!.db.delete(inboxMessages);
      await harness!.db.delete(outbox); // auto-ack rows FK→tickets; clear before tickets
      await harness!.db.delete(ticketTags); // Epic 4 auto-tags FK→tickets
      await harness!.db.delete(tickets);
      await harness!.db.update(projectCounters).set({ lastNo: 0 });
    }
  });

  it('IT-FILE-001: safe files stored by UUID, original name in metadata only', async () => {
    if (!ready) return;
    const raw = await buildRaw('<f1@x.com>', [
      { filename: 'doc.pdf', content: PDF },
      { filename: 'pic.png', content: PNG },
    ]);
    await seedInbox(harness!.db, HRIS, BOX, raw, '<f1@x.com>');
    await intake.processReceived();

    const rows = await harness!.db.select().from(attachments);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'stored')).toBe(true);
    for (const r of rows) {
      expect(path.basename(r.storagePath)).not.toBe(r.fileName); // path is a UUID, not the name
      const st = await fs.stat(path.join(storageRoot(), r.storagePath));
      expect(st.size).toBe(r.size);
    }
    expect(new Set(rows.map((r) => r.fileName))).toEqual(new Set(['doc.pdf', 'pic.png']));
  });

  it('IT-FILE-002: unsafe + spoofed-pdf blocked (no file); safe pdf stored', async () => {
    if (!ready) return;
    const raw = await buildRaw('<f2@x.com>', [
      { filename: 'real.pdf', content: PDF },
      { filename: 'tool.exe', content: EXE },
      { filename: 'invoice.pdf', content: EXE }, // .pdf name but executable bytes (AC3)
    ]);
    await seedInbox(harness!.db, HRIS, BOX, raw, '<f2@x.com>');
    await intake.processReceived();

    const rows = await harness!.db.select().from(attachments);
    const stored = rows.filter((r) => r.status === 'stored');
    const blocked = rows.filter((r) => r.status === 'blocked_unsafe');
    expect(stored.map((r) => r.fileName)).toEqual(['real.pdf']);
    expect(new Set(blocked.map((r) => r.fileName))).toEqual(new Set(['tool.exe', 'invoice.pdf']));
    expect(blocked.every((r) => r.storagePath === '')).toBe(true); // no file written
  });

  it('IT-FILE-003: repair — orphan row → failed; orphan file → counted', async () => {
    if (!ready) return;
    // A pending row whose file never made it to disk, aged past the threshold.
    const [t] = await harness!.db
      .insert(tickets)
      .values({ projectId: HRIS, ticketCode: '#09999', subject: 's', requesterEmail: 'a@x.com', mailbox: BOX })
      .returning({ id: tickets.id });
    await harness!.db.insert(attachments).values({
      ticketId: t!.id,
      fileName: 'lost.pdf',
      mimeType: 'application/pdf',
      size: 100,
      storagePath: `${HRIS}/2026/06/missing-uuid`,
      status: 'pending',
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
    // An orphan file on disk with no row.
    await writeFile(`${HRIS}/2026/06/orphan-uuid`, Buffer.from('orphan'));

    const res = await repairAttachments(60_000);
    expect(res.failed).toBe(1);
    expect(res.orphanFiles).toBeGreaterThanOrEqual(1);
    const [row] = await harness!.db.select().from(attachments);
    expect(row!.status).toBe('failed');
  });

  it('IT-FILE-004: path-traversal filename is neutralised (stored by UUID)', async () => {
    if (!ready) return;
    const raw = await buildRaw('<f4@x.com>', [{ filename: '../../etc/passwd', content: PDF }]);
    await seedInbox(harness!.db, HRIS, BOX, raw, '<f4@x.com>');
    await intake.processReceived();

    const [row] = await harness!.db.select().from(attachments).where(eq(attachments.status, 'stored'));
    expect(row).toBeDefined();
    // The path stays under the storage root and uses a UUID, not the traversal name.
    const abs = path.resolve(storageRoot(), row!.storagePath);
    expect(abs.startsWith(path.resolve(storageRoot()))).toBe(true);
    expect(row!.storagePath).not.toContain('..');
    expect(row!.fileName).toBe('../../etc/passwd'); // original kept as metadata
  });
});
