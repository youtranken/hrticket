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

/** 09:00 VN on a fixed day = 02:00 UTC. */
const NOW = new Date('2026-06-15T02:00:00Z');

/**
 * IT-DIGEST-001..004 — Story 6.2. The scheduler builds one digest per recipient past
 * the VN digest hour: right tickets, worklist order, deep links, capped at N, deduped
 * per VN day (which also yields catch-up after downtime), and silent when disabled.
 * Asserted at the outbox layer (SMTP delivery is covered by Epic 3). Needs Docker.
 */
describe('IT-DIGEST: daily outstanding digest', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new ReminderService();
  let Payroll: number;
  let A: { id: string; email: string };

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
    await harness!.db.update(reminderConfig).set({ digestEnabled: true, digestHour: 8, digestMaxN: 20, overdueDays: 3 }).where(eq(reminderConfig.projectId, 1));
  });

  let seq = 0;
  async function overdueTicket(daysAgo: number, assignee: string | null): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#D${String(seq).padStart(5, '0')}`,
        subject: `overdue ${seq}`,
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: 'in_progress',
        assigneeId: assignee,
        lastOpenedAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  it('IT-DIGEST-001: assignee gets their overdue tickets with links, worklist-ordered', async () => {
    if (!ready) return;
    const t1 = await overdueTicket(10, A.id); // more overdue
    const t2 = await overdueTicket(5, A.id); // less overdue
    const res = await svc.runDigests(NOW);
    expect(res.digests).toBeGreaterThanOrEqual(1);

    const rows = (await harness!.db.select().from(outbox)).filter((o) => (o.toAddrs ?? []).includes(A.email));
    expect(rows).toHaveLength(1);
    const body = rows[0]!.bodyText ?? '';
    expect(body).toContain('/tickets/' + t1);
    expect(body).toContain('/tickets/' + t2);
    // ③ more-overdue first → t1 listed before t2.
    expect(body.indexOf('/tickets/' + t1)).toBeLessThan(body.indexOf('/tickets/' + t2));
  });

  it('IT-DIGEST-002: deduped per VN day — a second tick the same day sends nothing', async () => {
    if (!ready) return;
    await overdueTicket(5, A.id);
    await svc.runDigests(NOW);
    const after1 = (await harness!.db.select().from(outbox)).filter((o) => (o.toAddrs ?? []).includes(A.email)).length;
    await svc.runDigests(new Date(NOW.getTime() + 3 * 3_600_000)); // later same VN day
    const after2 = (await harness!.db.select().from(outbox)).filter((o) => (o.toAddrs ?? []).includes(A.email)).length;
    expect(after1).toBe(1);
    expect(after2).toBe(1); // no second mail
  });

  it('IT-DIGEST-003: catch-up — first run after downtime (past the hour) still sends', async () => {
    if (!ready) return;
    await overdueTicket(5, A.id);
    // Worker was "down" at 08:00; first tick is 11:00 VN with no digest_log row yet.
    const late = new Date('2026-06-15T04:00:00Z'); // 11:00 VN
    const res = await svc.runDigests(late);
    expect(res.digests).toBeGreaterThanOrEqual(1);
  });

  it('IT-DIGEST-004: caps at N with overflow line; disabled project sends nothing', async () => {
    if (!ready) return;
    await harness!.db.update(reminderConfig).set({ digestMaxN: 20 }).where(eq(reminderConfig.projectId, 1));
    for (let i = 0; i < 30; i++) await overdueTicket(5 + i, A.id);
    await svc.runDigests(NOW);
    const row = (await harness!.db.select().from(outbox)).filter((o) => (o.toAddrs ?? []).includes(A.email))[0]!;
    const links = (row.bodyText ?? '').match(/\/tickets\//g) ?? [];
    expect(links.length).toBe(20); // capped
    expect(row.bodyText ?? '').toContain('+10');

    // Toggle off → no digest.
    await harness!.db.delete(outbox);
    await harness!.db.delete(digestLog);
    await harness!.db.update(reminderConfig).set({ digestEnabled: false }).where(eq(reminderConfig.projectId, 1));
    const res = await svc.runDigests(NOW);
    expect(res.digests).toBe(0);
  });
});
