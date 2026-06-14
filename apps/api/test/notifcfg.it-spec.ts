import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { tickets, outbox, digestLog, reminderConfig } from '../src/infra/db/schema';
import { AdminReminderService } from '../src/modules/admin/admin-reminder.service';
import { ReminderService } from '../src/modules/reminders/reminder.service';
import { TicketsReadService } from '../src/modules/tickets/tickets-read.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const NOW = new Date('2026-06-15T02:00:00Z'); // 09:00 VN

/**
 * IT-NOTIFCFG-001/002 — Story 6.4. The overdue threshold is one value with two
 * effects (red highlight + digest membership); a digest-hour/toggle change is honoured
 * on the next tick without a restart; "test send" drops a rendered sample into the
 * admin's mailbox. Needs Docker.
 */
describe('IT-NOTIFCFG: reminder config + template test-send', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const admin = new AdminReminderService();
  const reminders = new ReminderService();
  const read = new TicketsReadService();
  let Admin: SessionUser;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const a = (await makeUser(harness.db, { projectId: 1, email: 'admin-cfg@x.com', role: 'admin' }))!;
      Admin = { id: a.id, email: a.email, name: 'Cfg Admin', role: 'admin', projectId: 1, disabled: false, mustChangePassword: false };
      ready = true;
    } catch (e) {
      console.warn('[IT-NOTIFCFG] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(outbox);
    await harness!.db.delete(digestLog);
    await harness!.db.delete(tickets);
    await harness!.db.update(reminderConfig).set({ overdueDays: 3, digestHour: 8, digestEnabled: true, digestMaxN: 20 }).where(eq(reminderConfig.projectId, 1));
  });

  let seq = 0;
  async function overdue4d(ref: Date): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#CFG${String(seq).padStart(3, '0')}`,
        subject: 'four days',
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        status: 'in_progress',
        assigneeId: Admin.id,
        lastOpenedAt: new Date(ref.getTime() - 4 * 86_400_000),
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  it('IT-NOTIFCFG-001: one threshold drives BOTH red highlight and digest membership', async () => {
    if (!ready) return;
    // The read-service computes overdue with the DB's real now(), so frame the ticket
    // off real time and run the digest with hour 0 (always past) + now = real time.
    const realNow = new Date();
    await harness!.db.update(reminderConfig).set({ digestHour: 0 }).where(eq(reminderConfig.projectId, 1));
    const id = await overdue4d(realNow);

    // Threshold 3: a 4-day ticket is overdue (red) AND a digest candidate.
    expect((await read.getDetail(Admin, id)).ticket.isOverdue).toBe(true);
    expect((await reminders.runDigests(realNow)).digests).toBeGreaterThanOrEqual(1);

    // Raise to 5 → the SAME ticket is no longer red and drops out of the digest.
    await harness!.db.delete(outbox);
    await harness!.db.delete(digestLog);
    await admin.putConfig(Admin, 1, { overdueDays: 5, digestHour: 0, digestEnabled: true, digestMaxN: 20 });
    expect((await read.getDetail(Admin, id)).ticket.isOverdue).toBe(false);
    expect((await reminders.runDigests(realNow)).digests).toBe(0);
  });

  it('IT-NOTIFCFG-002: digest hour is hot-reloaded; test-send mails the admin', async () => {
    if (!ready) return;
    await overdue4d(NOW);
    // Move the hour to 23:00 → a 09:00 run is now before the hour → nothing.
    await admin.putConfig(Admin, 1, { overdueDays: 3, digestHour: 23, digestEnabled: true, digestMaxN: 20 });
    expect((await reminders.runDigests(NOW)).digests).toBe(0);
    // Back to 08:00 → the same 09:00 run fires (no restart needed).
    await admin.putConfig(Admin, 1, { overdueDays: 3, digestHour: 8, digestEnabled: true, digestMaxN: 20 });
    expect((await reminders.runDigests(NOW)).digests).toBeGreaterThanOrEqual(1);

    // Test-send the digest template → a [TEST] mail lands in the admin's mailbox.
    const res = await admin.testSend(Admin, 1, 'digest');
    expect(res.to).toBe(Admin.email);
    const mails = (await harness!.db.select().from(outbox)).filter((o) => (o.toAddrs ?? []).includes(Admin.email) && (o.subject ?? '').startsWith('[TEST]'));
    expect(mails.length).toBe(1);
  });

  it('IT-NOTIFCFG-validation: bad config is rejected (422)', async () => {
    if (!ready) return;
    await expect(admin.putConfig(Admin, 1, { overdueDays: 0, digestHour: 8, digestEnabled: true, digestMaxN: 20 })).rejects.toMatchObject({ status: 422 });
    await expect(admin.putConfig(Admin, 1, { overdueDays: 3, digestHour: 99, digestEnabled: true, digestMaxN: 20 })).rejects.toMatchObject({ status: 422 });
  });
});
