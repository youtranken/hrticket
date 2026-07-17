import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import {
  startGreenMail,
  injectMail,
  resetMail,
  fetchMailbox,
  type GreenMail,
} from './helpers/greenmail';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { enqueue } from '../src/infra/queue/outbox.service';
import { emailConnections, inboxMessages, imapCursor, outbox } from '../src/infra/db/schema';
import { EmailConnectionService, type ConnectionInput } from '../src/modules/admin/email-connection.service';
import { PollerService } from '../src/modules/email-engine/poller.service';
import { OutboxSender } from '../src/modules/email-engine/outbox-sender.service';
import { Mailer } from '../src/infra/mail/mailer';
import { resolveImapConfig, resolveSmtpConfig } from '../src/infra/mail/connection-resolver';
import { encryptSecret, decryptSecret } from '../src/infra/crypto/secret';

/**
 * IT-CONN-001..004 — Story 11.1: UI email-connection config + real Test-connection,
 * with the config source moved env→DB (DB-over-env precedence). Needs Docker
 * (Postgres + GreenMail); self-skips otherwise.
 */
describe('IT-CONN: email connection config + test + DB-over-env', () => {
  let harness: ItHarness | undefined;
  let gm: GreenMail | undefined;
  let ready = false;
  const svc = new EmailConnectionService();
  const HRIS = 1;
  const HRIS_BOX = 'hris@test.local';

  const admin = {
    id: '00000000-0000-0000-0000-0000000000aa',
    email: 'admin@dev.local',
    name: 'Admin',
    role: 'admin' as const,
    projectId: 1,
    disabled: false,
    mustChangePassword: false,
  };

  /** A DB connection row pointing at this GreenMail (App Password encrypted). */
  const upsertRow = async (imapUser: string, smtpUser = imapUser) =>
    harness!.db
      .insert(emailConnections)
      .values({
        projectId: HRIS,
        imapHost: gm!.host,
        imapPort: gm!.imapPort,
        imapUser,
        smtpHost: gm!.host,
        smtpPort: gm!.smtpPort,
        smtpUser,
        passwordEncrypted: encryptSecret('app-pw'),
        status: 'unknown',
      })
      .onConflictDoUpdate({
        target: emailConnections.projectId,
        set: { imapUser, smtpUser, imapHost: gm!.host, imapPort: gm!.imapPort, smtpHost: gm!.host, smtpPort: gm!.smtpPort },
      });

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      gm = await startGreenMail();
      ready = true;
    } catch (e) {
      console.warn('[IT-CONN] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (gm) await gm.stop();
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(inboxMessages);
    await harness!.db.delete(imapCursor);
    await harness!.db.delete(outbox);
    await harness!.db.delete(emailConnections);
    await harness!.db.execute(sql`DELETE FROM audit_log WHERE action LIKE 'email_connection%'`);
    await resetMail(gm!);
    // No env IMAP/SMTP for hris unless a test opts in — DB row is the source here.
    for (const k of ['IMAP_HRIS_HOST', 'IMAP_HRIS_PORT', 'IMAP_HRIS_USER', 'IMAP_HRIS_PASSWORD', 'SMTP_HRIS_HOST', 'SMTP_HRIS_PORT', 'SMTP_HRIS_USER', 'SMTP_HRIS_FROM']) {
      delete process.env[k];
    }
  });

  // ── IT-CONN-001: test-connection, 4 branches (AC1) ───────────────────────────
  it('IT-CONN-001: test-connection reports each leg independently (ok / imap-fail / smtp-fail / both-fail)', async () => {
    if (!ready) return;
    const base = (over: Partial<ConnectionInput>): ConnectionInput => ({
      imapHost: gm!.host,
      imapPort: gm!.imapPort,
      imapUser: HRIS_BOX,
      smtpHost: gm!.host,
      smtpPort: gm!.smtpPort,
      smtpUser: HRIS_BOX,
      password: 'app-pw',
      ...over,
    });

    const bothOk = await svc.testConnection(admin, HRIS, base({}));
    expect(bothOk.imap.ok).toBe(true);
    expect(typeof bothOk.imap.messages).toBe('number'); // INBOX count came back
    expect(bothOk.smtp.ok).toBe(true);

    const imapBad = await svc.testConnection(admin, HRIS, base({ imapPort: 1 }));
    expect(imapBad.imap.ok).toBe(false);
    expect(imapBad.imap.error).toBeTruthy();
    expect(imapBad.smtp.ok).toBe(true); // the other leg still ✅

    const smtpBad = await svc.testConnection(admin, HRIS, base({ smtpPort: 1 }));
    expect(smtpBad.imap.ok).toBe(true);
    expect(smtpBad.smtp.ok).toBe(false);
    expect(smtpBad.smtp.error).toBeTruthy();

    const bothBad = await svc.testConnection(admin, HRIS, base({ imapPort: 1, smtpPort: 1 }));
    expect(bothBad.imap.ok).toBe(false);
    expect(bothBad.smtp.ok).toBe(false);

    // No leg ever echoes the password back in an error string.
    for (const r of [bothOk, imapBad, smtpBad, bothBad]) {
      expect(JSON.stringify(r)).not.toContain('app-pw');
    }
  });

  // ── IT-CONN-002: hot-swap config without restart (AC2) ───────────────────────
  it('IT-CONN-002: changing the DB row swaps the polled mailbox on the next poll', async () => {
    if (!ready) return;
    const poller = new PollerService();
    const BOX_A = 'boxa@test.local';
    const BOX_B = 'boxb@test.local';

    await upsertRow(BOX_A);
    await injectMail(gm!, { from: 's@x.com', to: BOX_A, subject: 'to-A', text: 'a' });
    const r1 = await poller.pollMailbox({ id: HRIS, key: 'hris' });
    expect(r1.mailbox).toBe(BOX_A);
    expect(r1.inserted).toBe(1);

    // SSA edits the connection to a different mailbox — no restart.
    await harness!.db
      .update(emailConnections)
      .set({ imapUser: BOX_B, smtpUser: BOX_B })
      .where(eq(emailConnections.projectId, HRIS));

    await injectMail(gm!, { from: 's@x.com', to: BOX_B, subject: 'to-B', text: 'b' });
    const r2 = await poller.pollMailbox({ id: HRIS, key: 'hris' });
    expect(r2.mailbox).toBe(BOX_B); // next cycle used config B
    expect(r2.inserted).toBe(1);

    const boxes = await harness!.db.select({ mailbox: inboxMessages.mailbox }).from(inboxMessages);
    expect(boxes.map((b) => b.mailbox).sort()).toEqual([BOX_A, BOX_B]);
  });

  // ── IT-CONN-003: App Password encrypted, never leaks back (AC3) ───────────────
  it('IT-CONN-003: password stored ciphertext, GET masks, audit omits it', async () => {
    if (!ready) return;
    const secret = 'sup3r-secret-app-pw';
    await svc.update(admin, HRIS, 'hris', {
      imapHost: gm!.host,
      imapPort: gm!.imapPort,
      imapUser: HRIS_BOX,
      smtpHost: gm!.host,
      smtpPort: gm!.smtpPort,
      smtpUser: HRIS_BOX,
      password: secret,
    });

    const [row] = await harness!.db.select().from(emailConnections).where(eq(emailConnections.projectId, HRIS));
    expect(row!.passwordEncrypted).toBeTruthy();
    expect(row!.passwordEncrypted).not.toContain(secret); // ciphertext, not plaintext
    expect(decryptSecret(row!.passwordEncrypted!)).toBe(secret); // round-trips

    const view = await svc.get(HRIS, 'hris');
    expect(view.passwordMask).toBe('****p-pw'); // last 4 only
    expect(JSON.stringify(view)).not.toContain(secret);

    const auditRows = await harness!.db.execute(
      sql`SELECT new_value FROM audit_log WHERE action = 'email_connection.changed'`,
    );
    const dump = JSON.stringify(auditRows);
    expect(dump).toContain('passwordChanged');
    expect(dump).not.toContain(secret);

    // Editing other fields WITHOUT a password keeps the stored secret intact.
    await svc.update(admin, HRIS, 'hris', {
      imapHost: gm!.host,
      imapPort: gm!.imapPort,
      imapUser: 'renamed@test.local',
      smtpHost: gm!.host,
      smtpPort: gm!.smtpPort,
      smtpUser: 'renamed@test.local',
    });
    const [row2] = await harness!.db.select().from(emailConnections).where(eq(emailConnections.projectId, HRIS));
    expect(decryptSecret(row2!.passwordEncrypted!)).toBe(secret);
  });

  // ── IT-CONN-005: the stored App Password may not be replayed to a foreign host ─
  it('IT-CONN-005: test-connection refuses to send the stored password to a different host, and audits every attempt', async () => {
    if (!ready) return;
    const secret = 'sup3r-secret-app-pw';
    await svc.update(admin, HRIS, 'hris', {
      imapHost: gm!.host,
      imapPort: gm!.imapPort,
      imapUser: HRIS_BOX,
      smtpHost: gm!.host,
      smtpPort: gm!.smtpPort,
      smtpUser: HRIS_BOX,
      password: secret,
    });

    // The exfil shape: omit `password` (what the UI sends when the box is left
    // blank) and name a host the caller controls. The server must NOT decrypt the
    // stored secret and hand it over.
    const exfil = await svc.testConnection(admin, HRIS, {
      imapHost: 'evil.invalid',
      imapPort: 2143,
      imapUser: 'x',
      smtpHost: 'evil.invalid',
      smtpPort: 2525,
      smtpUser: 'x',
    });
    expect(exfil.imap.ok).toBe(false);
    expect(exfil.smtp.ok).toBe(false);
    expect(exfil.imap.error).toMatch(/host differs/i);

    // Refused BEFORE any socket is opened — and the attempt is on the record.
    const refusedAudit = await harness!.db.execute(
      sql`SELECT new_value FROM audit_log WHERE action = 'email_connection.tested'`,
    );
    const dump = JSON.stringify(refusedAudit);
    expect(dump).toContain('refusedHostMismatch');
    expect(dump).toContain('evil.invalid');
    expect(dump).not.toContain(secret); // the audit never carries the password

    // The saved host still tests fine without a password — the stored secret is
    // still usable for its own destination, so the guard costs the admin nothing.
    const sameHost = await svc.testConnection(admin, HRIS, {
      imapHost: gm!.host,
      imapPort: gm!.imapPort,
      imapUser: HRIS_BOX,
      smtpHost: gm!.host,
      smtpPort: gm!.smtpPort,
      smtpUser: HRIS_BOX,
    });
    expect(sameHost.imap.ok).toBe(true);
    expect(sameHost.smtp.ok).toBe(true);

    // A foreign host IS allowed when the caller supplies the password themselves —
    // they already know it, so nothing is disclosed. (Connection fails: no such host.)
    const byoPassword = await svc.testConnection(admin, HRIS, {
      imapHost: 'evil.invalid',
      imapPort: 2143,
      imapUser: 'x',
      smtpHost: 'evil.invalid',
      smtpPort: 2525,
      smtpUser: 'x',
      password: 'their-own-password',
    });
    expect(byoPassword.imap.error).not.toMatch(/host differs/i);
  }, 60000);

  // ── IT-CONN-004: core mail path stays green on config-from-DB + env fallback ──
  it('IT-CONN-004: poll + outbox + transactional send all work via the DB row, and env-fallback when no row', async () => {
    if (!ready) return;

    // (a) DB-config end-to-end: poll inbound + outbox send + transactional Mailer.
    await upsertRow(HRIS_BOX);

    // resolver returns the DB values (DB-over-env precedence).
    const imapCfg = await resolveImapConfig('hris');
    expect(imapCfg.imap.host).toBe(gm!.host);
    expect(imapCfg.imap.pass).toBe('app-pw'); // decrypted
    const smtpCfg = await resolveSmtpConfig('hris');
    expect(smtpCfg.host).toBe(gm!.host);

    await injectMail(gm!, { from: 'req@x.com', to: HRIS_BOX, subject: 'inbound-db-cfg', text: 'hi' });
    const poll = await new PollerService().pollMailbox({ id: HRIS, key: 'hris' });
    expect(poll.inserted).toBe(1);

    await withActor(systemActor, (tx) =>
      enqueue(tx, {
        projectId: HRIS,
        to: ['rcpt@x.com'],
        subject: 'outbound-db-cfg',
        bodyText: 'body',
        messageId: '<conn-ob-1@test.local>',
      }),
    );
    const sent = await new OutboxSender(new Mailer()).runOnce();
    expect(sent.sent).toBe(1);
    const delivered = await fetchMailbox(gm!, 'rcpt@x.com');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.from?.address).toBe(HRIS_BOX); // From = DB smtpUser

    // Transactional path (OTP/reset/alert) — Mailer reads the same DB row.
    await new Mailer().send({ to: 'otp@x.com', subject: 'your code', text: '123456' });
    const otp = await fetchMailbox(gm!, 'otp@x.com');
    expect(otp).toHaveLength(1);
    expect(otp[0]!.subject).toBe('your code');

    // (b) No row → env fallback still drives the poller (no regression for bootstrap).
    await harness!.db.delete(emailConnections);
    process.env.IMAP_HRIS_HOST = gm!.host;
    process.env.IMAP_HRIS_PORT = String(gm!.imapPort);
    process.env.IMAP_HRIS_USER = 'envbox@test.local';
    process.env.IMAP_HRIS_PASSWORD = 'test';
    process.env.IMAP_HRIS_SECURE = 'false';
    const envCfg = await resolveImapConfig('hris');
    expect(envCfg.mailbox).toBe('envbox@test.local'); // came from env, not DB

    await injectMail(gm!, { from: 'req2@x.com', to: 'envbox@test.local', subject: 'inbound-env', text: 'hi' });
    const poll2 = await new PollerService().pollMailbox({ id: HRIS, key: 'hris' });
    expect(poll2.mailbox).toBe('envbox@test.local');
    expect(poll2.inserted).toBe(1);
  });
});
