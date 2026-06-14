import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import {
  startGreenMail,
  resetMail,
  fetchMailbox,
  useGreenMailSmtpForHris,
  type GreenMail,
} from './helpers/greenmail';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { enqueue } from '../src/infra/queue/outbox.service';
import { OutboxSender } from '../src/modules/email-engine/outbox-sender.service';
import { Mailer } from '../src/infra/mail/mailer';
import { outbox, notifications } from '../src/infra/db/schema';

/**
 * IT-OUTBOX-001..004 — Story 3.1: at-least-once outbox sender. One of the four
 * deepest-tested areas. Needs Docker (Postgres + GreenMail); self-skips otherwise.
 */
describe('IT-OUTBOX: at-least-once sender', () => {
  let harness: ItHarness | undefined;
  let gm: GreenMail | undefined;
  let ready = false;
  const HRIS = 1;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      gm = await startGreenMail();
      useGreenMailSmtpForHris(gm);
      ready = true;
    } catch (e) {
      console.warn('[IT-OUTBOX] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (gm) await gm.stop();
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(outbox);
      await harness!.db.delete(notifications);
      await resetMail(gm!);
      useGreenMailSmtpForHris(gm!);
    }
  });

  const sender = () => new OutboxSender(new Mailer());

  it('IT-OUTBOX-001: pending row → delivered → done + smtp_dispatched_at', async () => {
    if (!ready) return;
    await withActor(systemActor, (tx) =>
      enqueue(tx, {
        projectId: HRIS,
        to: ['rcpt1@x.com'],
        subject: 'Hello from outbox',
        bodyText: 'body one',
        messageId: '<ob-1@test.local>',
      }),
    );

    const res = await sender().runOnce();
    expect(res.sent).toBe(1);

    const delivered = await fetchMailbox(gm!, 'rcpt1@x.com');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.subject).toBe('Hello from outbox');
    expect(delivered[0]!.from?.address).toBe('hris@test.local');

    const [row] = await harness!.db.select().from(outbox);
    expect(row!.status).toBe('done');
    expect(row!.smtpDispatchedAt).not.toBeNull();
  });

  it('IT-OUTBOX-004: same idempotency_key enqueued twice → one row', async () => {
    if (!ready) return;
    const key = '11111111-1111-1111-1111-111111111111';
    const a = await withActor(systemActor, (tx) =>
      enqueue(tx, { projectId: HRIS, to: ['d@x.com'], subject: 'dup', messageId: '<d1@t>', idempotencyKey: key }),
    );
    const b = await withActor(systemActor, (tx) =>
      enqueue(tx, { projectId: HRIS, to: ['d@x.com'], subject: 'dup', messageId: '<d2@t>', idempotencyKey: key }),
    );
    expect(b.deduped).toBe(true);
    expect(b.outboxId).toBe(a.outboxId);
    const rows = await harness!.db.select().from(outbox);
    expect(rows).toHaveLength(1);
  });

  it('IT-OUTBOX-003: row stuck in processing past lock timeout → re-claimed and sent', async () => {
    if (!ready) return;
    const { outboxId } = await withActor(systemActor, (tx) =>
      enqueue(tx, { projectId: HRIS, to: ['rcpt3@x.com'], subject: 'reclaim', bodyText: 'b', messageId: '<ob-3@t>' }),
    );
    // Simulate a worker that died mid-send: processing with a stale lock.
    await harness!.db
      .update(outbox)
      .set({ status: 'processing', lockedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(outbox.id, outboxId));

    const res = await sender().runOnce();
    expect(res.sent).toBe(1);
    const [row] = await harness!.db.select().from(outbox).where(eq(outbox.id, outboxId));
    expect(row!.status).toBe('done');
    const delivered = await fetchMailbox(gm!, 'rcpt3@x.com');
    expect(delivered).toHaveLength(1);
  });

  it('IT-OUTBOX-002: SMTP keeps failing → backoff → failed + admin alert, never lost', async () => {
    if (!ready) return;
    await withActor(systemActor, (tx) =>
      enqueue(tx, { projectId: HRIS, to: ['rcpt2@x.com'], subject: 'will fail', bodyText: 'b', messageId: '<ob-2@t>' }),
    );
    // Point SMTP at a dead port so every send fails. Fresh sender → fresh transport.
    process.env.SMTP_HRIS_HOST = '127.0.0.1';
    process.env.SMTP_HRIS_PORT = '1';
    const failing = new OutboxSender(new Mailer());

    let lastAttempts = 0;
    // Advance "now" past each backoff so the retry is claimable without real waiting.
    for (let i = 1; i <= 5; i++) {
      const now = new Date(Date.now() + i * 3 * 3_600_000);
      await failing.runOnce(20, now);
      const [row] = await harness!.db.select().from(outbox);
      lastAttempts = row!.attempts;
      if (row!.status === 'failed') break;
    }

    const [row] = await harness!.db.select().from(outbox);
    expect(row!.status).toBe('failed'); // dead-lettered, NOT deleted (nothing lost)
    expect(lastAttempts).toBe(5);

    const alerts = await harness!.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'outbox_failed'));
    expect(alerts.length).toBeGreaterThanOrEqual(1); // Admin/SSA alerted (AC2)
  });
});
