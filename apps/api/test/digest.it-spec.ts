import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import {
  categories,
  userGroupMembership,
  tickets,
  outbox,
  digestLog,
  reminderConfig,
} from '../src/infra/db/schema';
import { ReminderService } from '../src/modules/reminders/reminder.service';

/** 09:00 VN on a fixed day = 02:00 UTC (past the default 08:30 send time). */
const NOW = new Date('2026-06-15T02:00:00Z');
const DAY = 86_400_000;

/**
 * IT-DIGEST-001..005 — Story 6.2 reshaped by đơn 12. ONE consolidated digest per
 * project ADMIN once past the configured VN hh:mm, with two sections: pool tickets
 * unclaimed >= pool_unclaimed_days, and assigned tickets unfinished past
 * overdue_days (counted from assignment). Members/TLs receive NO digest mail.
 * Deduped per VN day (= catch-up after downtime), capped at N per section, silent
 * when disabled. Asserted at the outbox layer. Needs Docker.
 */
describe('IT-DIGEST: daily admin digest (đơn 12)', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new ReminderService();
  let Payroll: number;
  let A: { id: string; email: string }; // member (must NOT receive digests)
  let ADM: { id: string; email: string }; // project admin (the recipient)

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      const a = (await makeUser(harness.db, { projectId: 1, email: 'a-digest@x.com' }))!;
      A = { id: a.id, email: a.email };
      await harness.db.insert(userGroupMembership).values([{ userId: A.id, categoryId: Payroll }]);
      const adm = (await makeUser(harness.db, { projectId: 1, role: 'admin', email: 'adm-digest@x.com' }))!;
      ADM = { id: adm.id, email: adm.email };
      ready = true;
    } catch (e) {
      console.warn('[IT-DIGEST] Docker unavailable, skipping:', (e as Error)?.message);
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
    await harness!.db
      .update(reminderConfig)
      .set({ digestEnabled: true, digestHour: 8, digestMinute: 30, digestMaxN: 20, overdueDays: 3, poolUnclaimedDays: 2 })
      .where(eq(reminderConfig.projectId, 1));
  });

  let seq = 0;
  /** Assigned ticket: assigned `assignedDaysAgo` ago (the section-2 clock). */
  async function assignedTicket(assignedDaysAgo: number, assignee: string): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#D${String(seq).padStart(5, '0')}`,
        subject: `assigned ${seq}`,
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: 'in_progress',
        assigneeId: assignee,
        assignedAt: new Date(NOW.getTime() - assignedDaysAgo * DAY),
        lastOpenedAt: new Date(NOW.getTime() - assignedDaysAgo * DAY),
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  /** Pool ticket: open + unassigned, entered the pool `daysAgo` ago (section 1). */
  async function poolTicket(daysAgo: number): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#P${String(seq).padStart(5, '0')}`,
        subject: `pool ${seq}`,
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: 'open',
        assigneeId: null,
        lastOpenedAt: new Date(NOW.getTime() - daysAgo * DAY),
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  const mailsTo = async (email: string) =>
    (await harness!.db.select().from(outbox)).filter((o) => (o.toAddrs ?? []).includes(email));

  it('IT-DIGEST-001: ONE admin mail with both sections; the member gets nothing', async () => {
    if (!ready) return;
    const pOld = await poolTicket(3); // >= 2d unclaimed → section 1
    const pFresh = await poolTicket(1); // too fresh → NOT listed
    const slow = await assignedTicket(5, A.id); // > 3d assigned → section 2
    const fine = await assignedTicket(1, A.id); // within threshold → NOT listed

    const res = await svc.runDigests(NOW);
    expect(res.digests).toBeGreaterThanOrEqual(1);

    const adminMails = await mailsTo(ADM.email);
    expect(adminMails).toHaveLength(1);
    const body = adminMails[0]!.bodyText ?? '';
    expect(body).toContain('Pool chưa ai nhận');
    expect(body).toContain('/tickets/' + pOld);
    expect(body).not.toContain('/tickets/' + pFresh);
    expect(body).toContain('Đã giao quá');
    expect(body).toContain('/tickets/' + slow);
    expect(body).not.toContain('/tickets/' + fine);

    // Đơn 12: the assignee/member is mail-free — the in-app red badge is their signal.
    expect(await mailsTo(A.email)).toHaveLength(0);
  });

  it('IT-DIGEST-002: deduped per VN day — a second tick the same day sends nothing', async () => {
    if (!ready) return;
    await poolTicket(3);
    await svc.runDigests(NOW);
    expect(await mailsTo(ADM.email)).toHaveLength(1);
    await svc.runDigests(new Date(NOW.getTime() + 3 * 3_600_000)); // later same VN day
    expect(await mailsTo(ADM.email)).toHaveLength(1); // no second mail
  });

  it('IT-DIGEST-003: hh:mm gate — 08:15 VN is silent, 08:35 VN sends (catch-up too)', async () => {
    if (!ready) return;
    await poolTicket(3);
    // 08:15 VN = 01:15 UTC — before the 08:30 send time.
    expect((await svc.runDigests(new Date('2026-06-15T01:15:00Z'))).digests).toBe(0);
    // 08:35 VN — past the minute; also proves catch-up (no earlier run today).
    expect((await svc.runDigests(new Date('2026-06-15T01:35:00Z'))).digests).toBeGreaterThanOrEqual(1);
  });

  it('IT-DIGEST-004: caps at N per section with overflow line; disabled project sends nothing', async () => {
    if (!ready) return;
    for (let i = 0; i < 30; i++) await assignedTicket(5 + i, A.id);
    await svc.runDigests(NOW);
    const row = (await mailsTo(ADM.email))[0]!;
    const links = (row.bodyText ?? '').match(/\/tickets\//g) ?? [];
    expect(links.length).toBe(20); // capped per section
    expect(row.bodyText ?? '').toContain('+10');

    // Toggle off → no digest.
    await harness!.db.delete(outbox);
    await harness!.db.delete(digestLog);
    await harness!.db.update(reminderConfig).set({ digestEnabled: false }).where(eq(reminderConfig.projectId, 1));
    expect((await svc.runDigests(NOW)).digests).toBe(0);
  });

  it('IT-DIGEST-005: snoozed-in-window assigned ticket is exempt; snooze-due is listed', async () => {
    if (!ready) return;
    const waiting = await assignedTicket(10, A.id);
    await harness!.db
      .update(tickets)
      .set({ status: 'pending', snoozeUntil: '2026-06-20' }) // future snooze → exempt
      .where(eq(tickets.id, waiting));
    const due = await assignedTicket(10, A.id);
    await harness!.db
      .update(tickets)
      .set({ status: 'pending', snoozeUntil: '2026-06-14' }) // past snooze → due
      .where(eq(tickets.id, due));

    await svc.runDigests(NOW);
    const body = (await mailsTo(ADM.email))[0]!.bodyText ?? '';
    expect(body).not.toContain('/tickets/' + waiting);
    expect(body).toContain('/tickets/' + due);
  });
});
