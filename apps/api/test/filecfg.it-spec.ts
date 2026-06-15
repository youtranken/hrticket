import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer';
import { and, eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { seedInbox } from './helpers/mail-raw';
import { IntakeService } from '../src/modules/intake/intake.service';
import { UploadService } from '../src/modules/tickets/upload.service';
import { AttachmentConfigService } from '../src/modules/admin/attachment-config.service';
import { DiskMonitorService } from '../src/modules/monitor/disk-monitor.service';
import * as fsStorage from '../src/infra/storage/fs-storage';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { makeUser } from './factories/user.factory';
import {
  inboxMessages,
  tickets,
  ticketMessages,
  participants,
  attachments,
  projectCounters,
  projectSettings,
  outbox,
  ticketTags,
  tags,
  notifications,
  users,
} from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';

const HRIS = 1;
const BOX = 'hris@test.local';

// Real magic-byte payloads.
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 0x00)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(16, 0x20)]);

function buildRaw(messageId: string, atts: { filename: string; content: Buffer }[]): Promise<string> {
  return new Promise((resolve, reject) => {
    new MailComposer({
      from: 'a@x.com',
      to: 'hris@test.local',
      subject: 'cfg files',
      text: 'see attached',
      messageId,
      attachments: atts.map((a) => ({ filename: a.filename, content: a.content })),
    })
      .compile()
      .build((err, msg) => (err ? reject(err) : resolve(msg.toString('utf8'))));
  });
}

/**
 * IT-FILECFG-001..002 — Story 8.4. Whitelist hot-reload across BOTH doors (ingest +
 * upload), auto-tag toggle, disk-low alert + dedup, and config audit. Needs Docker.
 */
describe('IT-FILECFG: attachment config + disk monitor', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  let tmpRoot = '';
  const intake = new IntakeService();
  const uploads = new UploadService();
  const cfg = new AttachmentConfigService();
  let admin: SessionUser;

  beforeAll(async () => {
    try {
      tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hris-filecfg-'));
      process.env.ATTACHMENT_STORAGE_ROOT = tmpRoot;
      harness = await startHarness({ seed: true });
      const a = await makeUser(harness.db, { projectId: HRIS, email: 'cfgadmin@t.local', role: 'admin' });
      admin = {
        id: a!.id,
        email: a!.email,
        name: a!.name,
        role: 'admin',
        projectId: HRIS,
        disabled: false,
        mustChangePassword: false,
      };
      ready = true;
    } catch (e) {
      console.warn('[IT-FILECFG] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(attachments);
    await harness!.db.delete(participants);
    await harness!.db.delete(ticketMessages);
    await harness!.db.delete(inboxMessages);
    await harness!.db.delete(outbox);
    await harness!.db.delete(ticketTags);
    await harness!.db.delete(tickets);
    await harness!.db.update(projectCounters).set({ lastNo: 0 });
    // Reset whitelist + cap to a known baseline.
    await harness!.db
      .update(projectSettings)
      .set({ allowedExtensions: ['pdf', 'png', 'mp3'], attachmentCapMb: 50 })
      .where(eq(projectSettings.projectId, HRIS));
  });

  const uploadTicket = async (): Promise<string> =>
    withActor(systemActor, async (tx) => {
      const [t] = await tx
        .insert(tickets)
        .values({
          projectId: HRIS,
          ticketCode: `#${String(Math.floor(Math.random() * 90000) + 10000)}`,
          subject: 'cfg',
          requesterEmail: 'r@x.com',
          mailbox: BOX,
          status: 'open',
        })
        .returning({ id: tickets.id });
      return t!.id;
    });

  it('IT-FILECFG-001: whitelist change hot-reloads BOTH doors (ingest + upload)', async () => {
    if (!ready) return;
    // Baseline: gif NOT allowed → ingest blocks it, upload rejects it.
    const raw1 = await buildRaw('<g1@x.com>', [{ filename: 'a.gif', content: GIF }]);
    await seedInbox(harness!.db, HRIS, BOX, raw1, '<g1@x.com>');
    await intake.processReceived();
    const rows = await harness!.db.select().from(attachments);
    expect(rows.every((r) => r.status === 'blocked_unsafe')).toBe(true);

    const t1 = await uploadTicket();
    await expect(uploads.store(admin, t1, { fileName: 'a.gif', content: GIF })).rejects.toMatchObject({
      status: 422,
    });

    // Admin ADDS gif → both doors accept it immediately (no restart).
    await cfg.update(admin, HRIS, { allowedExtensions: ['pdf', 'png', 'mp3', 'gif'] });

    const raw2 = await buildRaw('<g2@x.com>', [{ filename: 'b.gif', content: GIF }]);
    await seedInbox(harness!.db, HRIS, BOX, raw2, '<g2@x.com>');
    await intake.processReceived();
    const stored = (await harness!.db.select().from(attachments)).filter((r) => r.status === 'stored');
    expect(stored.some((r) => r.fileName === 'b.gif')).toBe(true);

    const t2 = await uploadTicket();
    const up = await uploads.store(admin, t2, { fileName: 'c.gif', content: GIF });
    expect(up.status).toBe('stored');

    // Admin REMOVES gif → upload rejected again (old stored gif still exists in DB).
    await cfg.update(admin, HRIS, { allowedExtensions: ['pdf', 'png', 'mp3'] });
    const t3 = await uploadTicket();
    await expect(uploads.store(admin, t3, { fileName: 'd.gif', content: GIF })).rejects.toMatchObject({
      status: 422,
    });
    const stillStored = await harness!.db
      .select()
      .from(attachments)
      .where(eq(attachments.fileName, 'b.gif'));
    expect(stillStored[0]!.status).toBe('stored'); // old file unaffected
  });

  it('IT-FILECFG-001: signatureWarning flags an extension with no magic signature', async () => {
    if (!ready) return;
    const view = await cfg.update(admin, HRIS, { allowedExtensions: ['pdf', 'docx'] });
    expect(view.signatureWarning).toContain('docx');
    expect(view.signatureWarning).not.toContain('pdf');
  });

  it('IT-FILECFG-002: Attachment auto-tag toggle off → new ticket with a file is NOT tagged', async () => {
    if (!ready) return;
    // Toggle Attachment auto-tag OFF.
    await cfg.update(admin, HRIS, { autotag: { attachment: false } });
    const raw = await buildRaw('<t1@x.com>', [{ filename: 'doc.pdf', content: PDF }]);
    await seedInbox(harness!.db, HRIS, BOX, raw, '<t1@x.com>');
    await intake.processReceived();
    const [tk] = await harness!.db.select({ id: tickets.id }).from(tickets);
    const tagged = await harness!.db
      .select({ name: tags.name })
      .from(ticketTags)
      .innerJoin(tags, eq(tags.id, ticketTags.tagId))
      .where(eq(ticketTags.ticketId, tk!.id));
    expect(tagged.map((t) => t.name)).not.toContain('Attachment');

    // Toggle ON → a fresh ticket with a file IS tagged.
    await cfg.update(admin, HRIS, { autotag: { attachment: true } });
    const raw2 = await buildRaw('<t2@x.com>', [{ filename: 'doc2.pdf', content: PDF }]);
    await seedInbox(harness!.db, HRIS, BOX, raw2, '<t2@x.com>');
    await intake.processReceived();
    const all = await harness!.db.select({ id: tickets.id, code: tickets.ticketCode }).from(tickets);
    const newest = all[all.length - 1]!;
    const tagged2 = await harness!.db
      .select({ name: tags.name })
      .from(ticketTags)
      .innerJoin(tags, eq(tags.id, ticketTags.tagId))
      .where(eq(ticketTags.ticketId, newest.id));
    expect(tagged2.map((t) => t.name)).toContain('Attachment');
  });

  it('IT-FILECFG-002: disk-low alert fires for Admin/SSA then dedups same day', async () => {
    if (!ready) return;
    await harness!.db.delete(notifications);
    // Threshold 15%; mock the filesystem to report only 10% free → breach.
    await harness!.db.update(projectSettings).set({ diskAlertPct: 15 }).where(eq(projectSettings.projectId, HRIS));
    const spy = jest.spyOn(fsStorage, 'diskUsage').mockResolvedValue({
      totalBytes: 100,
      freeBytes: 10,
      usedBytes: 90,
      usedPct: 90,
      freePct: 10,
    });
    // Mailer is a no-op here (no SMTP) — the in-app notifications are the assertion.
    const monitor = new DiskMonitorService({ send: async () => undefined } as never);

    const r1 = await monitor.checkDiskOnce(new Date('2026-06-14T03:00:00Z'));
    expect(r1.breached).toContain(HRIS);
    expect(r1.alerted).toContain(HRIS);
    // HRIS recipients = project-scoped admins of HRIS + all SSAs (SSA spans projects).
    const hrisAdmins = (
      await harness!.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.projectId, HRIS)))
    ).length;
    const ssaCount = (await harness!.db.select({ id: users.id }).from(users).where(eq(users.role, 'ssa'))).length;
    const hrisNotifs = async () =>
      harness!.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'disk_low'),
            sql`(${notifications.payload}::jsonb ->> 'projectId') = ${String(HRIS)}`,
          ),
        );
    const first = await hrisNotifs();
    expect(first.length).toBe(hrisAdmins + ssaCount);

    // Same VN-day again → deduped for HRIS (no new HRIS rows).
    const r2 = await monitor.checkDiskOnce(new Date('2026-06-14T09:00:00Z'));
    expect(r2.alerted).not.toContain(HRIS);
    const second = await hrisNotifs();
    expect(second.length).toBe(first.length); // unchanged

    spy.mockRestore();
  });

  it('IT-FILECFG-002: config update is audited old→new', async () => {
    if (!ready) return;
    await cfg.update(admin, HRIS, { capMb: 77 });
    // audit_log is custom SQL (not in the Drizzle schema) — query it raw.
    const rows = (await harness!.db.execute(
      sql`SELECT action, old_value, new_value FROM audit_log WHERE action = 'attachment_config.updated' ORDER BY created_at DESC LIMIT 1`,
    )) as unknown as Array<{ action: string; old_value: unknown; new_value: unknown }>;
    expect(rows[0]?.action).toBe('attachment_config.updated');
    expect((rows[0]!.new_value as { capMb: number }).capMb).toBe(77);
  });
});
