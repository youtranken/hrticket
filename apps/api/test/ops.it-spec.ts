import { Logger } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { startLoop } from '../src/modules/worker/loop-runner';
import { MonitorService } from '../src/modules/monitor/monitor.service';
import { alertMailboxDown, MAILBOX_ALERT_TYPE } from '../src/modules/monitor/mailbox-alert';
import { workerHeartbeats, notifications, users } from '../src/infra/db/schema';
import type { Mailer } from '../src/infra/mail/mailer';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('IT-OPS: worker loops + monitor', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const sentTo: string[] = [];
  const stubMailer = {
    send: (msg: { to: string }) => {
      sentTo.push(msg.to);
      return Promise.resolve();
    },
  } as unknown as Mailer;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      ready = true;
    } catch (e) {
      console.warn('[IT-OPS] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(notifications);
      await harness!.db.delete(workerHeartbeats);
      sentTo.length = 0;
    }
  });

  it('IT-OPS-004: a crashing loop does not stop the others (both keep beating)', async () => {
    if (!ready) return;
    const logger = new Logger('test');
    const stopGood = startLoop({ name: 'good', intervalMs: 40, tick: () => Promise.resolve() }, logger);
    const stopBad = startLoop(
      { name: 'bad', intervalMs: 40, tick: () => Promise.reject(new Error('boom')) },
      logger,
    );
    await delay(250); // several cycles
    stopGood();
    stopBad();

    const beats = await harness!.db.select().from(workerHeartbeats);
    const good = beats.find((b) => b.loopName === 'good')!;
    const bad = beats.find((b) => b.loopName === 'bad')!;
    expect(good.status).toBe('ok');
    expect(bad.status).toBe('error'); // it failed...
    // ...but kept its cadence: its heartbeat is recent, not frozen at first failure.
    expect(Date.now() - new Date(bad.lastBeatAt).getTime()).toBeLessThan(2000);
  });

  it('IT-OPS-005/007: stale heartbeat → alert to every Admin/SSA, deduped 1/hour', async () => {
    if (!ready) return;
    await makeUser(harness!.db, { projectId: 1, email: 'admin-ops@t.local', role: 'admin' });
    await makeUser(harness!.db, { projectId: 1, email: 'ssa-ops@t.local', role: 'ssa' });
    await makeUser(harness!.db, { projectId: 1, email: 'member-ops@t.local', role: 'member' });

    // imap_poll last beat is way in the past → stale.
    await harness!.db.insert(workerHeartbeats).values({ loopName: 'imap_poll', status: 'ok' });
    await harness!.db
      .update(workerHeartbeats)
      .set({ lastBeatAt: sql`now() - interval '1 hour'` })
      .where(eq(workerHeartbeats.loopName, 'imap_poll'));

    // Everyone who should be alerted: all non-disabled admin/ssa (incl. the seeded SSA).
    const recipients = await harness!.db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.role, ['admin', 'ssa']));
    const expected = recipients.length; // ≥ 2 (admin-ops + ssa-ops + seeded SSA)

    const monitor = new MonitorService(stubMailer);
    const first = await monitor.checkOnce();
    expect(first.alerted).toBe(true);
    expect(first.notified).toBe(expected); // admin/ssa only, never the member

    const notes = await harness!.db.select().from(notifications);
    expect(notes).toHaveLength(expected);
    expect(notes.every((n) => n.type === 'worker_alert')).toBe(true);
    expect(sentTo).toHaveLength(1); // one email to all recipients

    // Second pass within the hour → deduped, nothing new.
    const second = await monitor.checkOnce();
    expect(second.notified).toBe(0);
    expect(await harness!.db.select().from(notifications)).toHaveLength(expected);
    expect(sentTo).toHaveLength(1);
  });

  it('IT-OPS-008: a failing mailbox alerts THAT project\'s admins + SSA only, deduped 1/hour', async () => {
    if (!ready) return;
    // Seed creates projects hris=1, cnb=2 and one SSA in project 1 (global by role).
    const adminHris = (await makeUser(harness!.db, { projectId: 1, email: 'admin-hris@t.local', role: 'admin' }))!;
    const adminCnb = (await makeUser(harness!.db, { projectId: 2, email: 'admin-cnb@t.local', role: 'admin' }))!;
    await makeUser(harness!.db, { projectId: 2, email: 'member-cnb@t.local', role: 'member' });
    const ssa = await harness!.db.select({ id: users.id }).from(users).where(eq(users.role, 'ssa'));

    // The CNB (project 2) mailbox fails.
    const n = await alertMailboxDown({ projectId: 2, projectKey: 'cnb', projectName: 'C&B', error: 'Invalid credentials' });

    // Recipients = CNB admin + every SSA; NEVER the HRIS admin, NEVER the CNB member.
    const expected = 1 + ssa.length;
    expect(n).toBe(expected);
    const notes = await harness!.db.select().from(notifications);
    expect(notes).toHaveLength(expected);
    expect(notes.every((r) => r.type === MAILBOX_ALERT_TYPE)).toBe(true);
    const gotIds = new Set(notes.map((r) => r.actorId));
    expect(gotIds.has(adminCnb.id)).toBe(true);
    expect(gotIds.has(adminHris.id)).toBe(false); // the OTHER project stays silent
    for (const s of ssa) expect(gotIds.has(s.id)).toBe(true);
    // Payload carries which mailbox + the error, so the bell shows detail (not "System alert").
    const payload = JSON.parse(notes[0]!.payload!) as { projectKey: string; error: string };
    expect(payload.projectKey).toBe('cnb');
    expect(payload.error).toContain('Invalid credentials');

    // Same project within the hour → deduped, nothing new.
    expect(await alertMailboxDown({ projectId: 2, projectKey: 'cnb', projectName: 'C&B', error: 'still down' })).toBe(0);
    expect(await harness!.db.select().from(notifications)).toHaveLength(expected);

    // A DIFFERENT project (HRIS) is a separate dedup bucket → it still alerts, and reaches
    // at least our HRIS admin + every SSA. (Prior tests leave extra project-1 admins around —
    // beforeEach clears notifications, not users — so assert a lower bound, not an exact count.)
    const m = await alertMailboxDown({ projectId: 1, projectKey: 'hris', projectName: 'HRIS', error: 'timeout' });
    expect(m).toBeGreaterThanOrEqual(1 + ssa.length);
  });

  it('IT-OPS: a healthy/fresh heartbeat raises no alert', async () => {
    if (!ready) return;
    await makeUser(harness!.db, { projectId: 1, email: 'admin-ok@t.local', role: 'admin' });
    await harness!.db.insert(workerHeartbeats).values({ loopName: 'imap_poll', status: 'ok' });
    const monitor = new MonitorService(stubMailer);
    const res = await monitor.checkOnce();
    expect(res.alerted).toBe(false);
    expect(await harness!.db.select().from(notifications)).toHaveLength(0);
  });
});
