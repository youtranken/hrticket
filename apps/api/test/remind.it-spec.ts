import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import {
  categories,
  users,
  userGroupMembership,
  tickets,
  outbox,
  notifications,
  snoozeReminderLog,
  reminderConfig,
} from '../src/infra/db/schema';
import { ReminderService } from '../src/modules/reminders/reminder.service';
import { handleReplyTransition } from '../src/modules/intake/reopen.usecase';

function vnDateStr(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

/**
 * IT-REMIND-001..003 — Story 6.3. Snooze-due tickets nudge the assignee once per VN
 * day (email + in-app), reopen e-mails the kept assignee (pool reopen is in-app only),
 * and all of it runs even when the digest is switched off (FR50/51 are fixed). Docker.
 */
describe('IT-REMIND: snooze reminder + reopen notify', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new ReminderService();
  let Payroll: number;
  let A: string; // assignee, active + in group
  let M: string; // group member (for pool reopen fan-out)

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      A = (await makeUser(harness.db, { projectId: 1, email: 'a-remind@x.com' }))!.id;
      M = (await makeUser(harness.db, { projectId: 1, email: 'm-remind@x.com' }))!.id;
      await harness.db.insert(userGroupMembership).values([
        { userId: A, categoryId: Payroll },
        { userId: M, categoryId: Payroll },
      ]);
      ready = true;
    } catch (e) {
      console.warn('[IT-REMIND] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(outbox);
    await harness!.db.delete(notifications);
    await harness!.db.delete(snoozeReminderLog);
    await harness!.db.delete(tickets);
    await harness!.db.update(users).set({ disabled: false }).where(eq(users.id, A));
    await harness!.db.update(reminderConfig).set({ digestEnabled: true }).where(eq(reminderConfig.projectId, 1));
  });

  let seq = 0;
  async function ticket(status: string, opts: { snoozeUntil?: string; assignee?: string | null }): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#M${String(seq).padStart(5, '0')}`,
        subject: `t ${seq}`,
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: status as 'pending',
        snoozeUntil: opts.snoozeUntil ?? null,
        assigneeId: opts.assignee ?? null,
      })
      .returning({ id: tickets.id });
    return row!.id;
  }
  const outboxFor = async (id: string) =>
    harness!.db.select().from(outbox).where(eq(outbox.ticketId, id));
  const fire = (id: string) =>
    withActor(systemActor, (tx) =>
      handleReplyTransition(tx, { ticketId: id, projectId: 1, fromAddr: 'r@x.com', fromIsActiveParticipant: true, isAutoReply: false }),
    );

  it('IT-REMIND-001: snooze-due → 1 email + 1 in-app, deduped per day', async () => {
    if (!ready) return;
    const t = await ticket('pending', { snoozeUntil: vnDateStr(0), assignee: A });
    const r1 = await svc.runSnoozeReminders(new Date());
    expect(r1.reminders).toBe(1);
    const mails = (await harness!.db.select().from(outbox)).filter((o) => (o.toAddrs ?? []).includes('a-remind@x.com'));
    expect(mails).toHaveLength(1);
    const inApp = await harness!.db.select().from(notifications).where(eq(notifications.actorId, A));
    expect(inApp.some((n) => n.type === 'snooze_due')).toBe(true);

    const r2 = await svc.runSnoozeReminders(new Date());
    expect(r2.reminders).toBe(0); // deduped
    expect((await harness!.db.select().from(outbox)).filter((o) => (o.toAddrs ?? []).includes('a-remind@x.com'))).toHaveLength(1);
    void t;
  });

  it('IT-REMIND-002: reopen keeps assignee → email + in-app; pool reopen → in-app only', async () => {
    if (!ready) return;
    // (a) closed, assignee active + in group → reopen keeps them, e-mails them.
    const t1 = await ticket('closed', { assignee: A });
    await fire(t1);
    expect(await outboxFor(t1)).toHaveLength(1); // ticket_reopened email
    const n1 = await harness!.db.select().from(notifications).where(eq(notifications.actorId, A));
    expect(n1.some((n) => n.type === 'ticket_reopened')).toBe(true);

    // (b) closed, assignee disabled → pool, in-app to the group, NO email.
    await harness!.db.update(users).set({ disabled: true }).where(eq(users.id, A));
    const t2 = await ticket('closed', { assignee: A });
    await fire(t2);
    expect(await outboxFor(t2)).toHaveLength(0); // no per-person email
    const nM = await harness!.db.select().from(notifications).where(eq(notifications.actorId, M));
    expect(nM.some((n) => n.type === 'ticket_reopened_pool')).toBe(true);
  });

  it('IT-REMIND-003: snooze reminders fire even when digest is disabled (FR50 fixed)', async () => {
    if (!ready) return;
    await harness!.db.update(reminderConfig).set({ digestEnabled: false }).where(eq(reminderConfig.projectId, 1));
    await ticket('pending', { snoozeUntil: vnDateStr(0), assignee: A });
    const r = await svc.runSnoozeReminders(new Date());
    expect(r.reminders).toBe(1);
  });
});
