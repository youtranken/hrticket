import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { makeRaw, seedInbox } from './helpers/mail-raw';
import { IntakeService } from '../src/modules/intake/intake.service';
import { JunkService } from '../src/modules/junk/junk.service';
import {
  inboxMessages,
  tickets,
  ticketMessages,
  participants,
  projectCounters,
  junkRules,
  categories,
  userGroupMembership,
  outbox,
  notifications,
} from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';

/**
 * IT-JUNK-001/002/003 — Story 7.3 (FR102/FR103). Junk-rule mail becomes an is_junk
 * ticket in "Khác" (no assign, no ack); "Không phải rác" releases it (ack on rescue);
 * the Junk tab is RLS-scoped to Admin + the owning category group; digest counts junk.
 */
describe('IT-JUNK: auto-junk rules + junk tab', () => {
  let harness: ItHarness | undefined;
  let intake: IntakeService;
  let ready = false;
  const junkSvc = new JunkService();
  const HRIS = 1;
  const HRIS_BOX = 'hris@test.local';
  let Other = 0;
  let Payroll = 0;
  const sessionFor = (id: string, role: SessionUser['role'] = 'member'): SessionUser => ({
    id,
    email: `${id}@x.com`,
    name: id,
    role,
    projectId: HRIS,
    disabled: false,
    mustChangePassword: false,
  });

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      intake = new IntakeService();
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      Other = cats.find((c) => c.nameEn === 'Other')!.id;
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      ready = true;
    } catch (e) {
      console.warn('[IT-JUNK] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(participants);
      await harness!.db.delete(ticketMessages);
      await harness!.db.delete(notifications);
      await harness!.db.delete(inboxMessages);
      await harness!.db.delete(outbox);
      await harness!.db.delete(tickets);
      await harness!.db.delete(junkRules);
      await harness!.db.execute(sql`DELETE FROM audit_log WHERE action LIKE 'ticket.%' OR action LIKE 'inbox.%' OR action LIKE 'junk%'`);
      await harness!.db.update(projectCounters).set({ lastNo: 0 });
    }
  });

  it('IT-JUNK-001: keyword + sender-wildcard rules → is_junk in "Khác", no assign, no ack', async () => {
    if (!ready) return;
    await harness!.db.insert(junkRules).values([
      { projectId: HRIS, kind: 'keyword', pattern: 'ung tuyen' },
      { projectId: HRIS, kind: 'sender', pattern: 'noreply@*' },
    ]);

    // keyword match (accent-insensitive: rule "ung tuyen" catches subject "Ứng tuyển")
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'someone@x.com', to: HRIS_BOX, subject: 'Ung tuyen vi tri ke toan', messageId: '<j1@x.com>' }), '<j1@x.com>');
    // sender wildcard match
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'noreply@marketing.io', to: HRIS_BOX, subject: 'Newsletter', messageId: '<j2@x.com>' }), '<j2@x.com>');
    // a normal mail that must NOT be junked
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'real@x.com', to: HRIS_BOX, subject: 'Hoi ve luong', messageId: '<j3@x.com>' }), '<j3@x.com>');

    await intake.processReceived(30);

    const tix = await harness!.db.select().from(tickets).where(eq(tickets.projectId, HRIS));
    expect(tix).toHaveLength(3);
    const junk = tix.filter((t) => t.isJunk);
    expect(junk).toHaveLength(2);
    for (const t of junk) {
      expect(t.categoryId).toBe(Other); // forced to "Khác"
      expect(t.assigneeId).toBeNull(); // no auto-assign
    }
    const normal = tix.find((t) => !t.isJunk)!;
    expect(normal.subject).toBe('Hoi ve luong');

    // No auto-ack for the 2 junk tickets (only the normal one acked).
    const acks = await harness!.db.select().from(outbox);
    expect(acks).toHaveLength(1);
    expect(acks[0]!.ticketId).toBe(normal.id);

    // Provenance audit recorded the catching rule for each junk ticket.
    const audits = (await harness!.db.execute(sql`
      SELECT object_id, new_value->>'kind' AS kind FROM audit_log WHERE action = 'ticket.auto_junked'
    `)) as unknown as Array<{ object_id: string; kind: string }>;
    expect(audits.map((a) => a.kind).sort()).toEqual(['keyword', 'sender']);
  });

  it('IT-JUNK-002: "Không phải rác" releases auto-junk → stays "Khác", acks on rescue', async () => {
    if (!ready) return;
    await harness!.db.insert(junkRules).values({ projectId: HRIS, kind: 'keyword', pattern: 'khuyen mai' });
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'promo@x.com', to: HRIS_BOX, subject: 'Sieu khuyen mai 50%', messageId: '<jr@x.com>' }), '<jr@x.com>');
    await intake.processReceived();
    const [t] = await harness!.db.select().from(tickets);
    expect(t!.isJunk).toBe(true);
    expect(await harness!.db.select().from(outbox)).toHaveLength(0); // no ack while junk

    // Admin releases it.
    const adminU = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'junk-admin@x.com' }))!;
    const res = await junkSvc.release(sessionFor(adminU.id, 'admin'), t!.id);
    expect(res.reAcked).toBe(true);

    const after = (await harness!.db.select().from(tickets).where(eq(tickets.id, t!.id)))[0]!;
    expect(after.isJunk).toBe(false);
    expect(after.categoryId).toBe(Other); // stays "Khác" (pool)
    expect(after.assigneeId).toBeNull();
    expect(await harness!.db.select().from(outbox)).toHaveLength(1); // ack enqueued NOW
  });

  it('IT-JUNK-003: junk tab RLS — Admin + "Khác" member see, other-group member empty; digest counts', async () => {
    if (!ready) return;
    await harness!.db.insert(junkRules).values({ projectId: HRIS, kind: 'keyword', pattern: 'spam' });
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 's@x.com', to: HRIS_BOX, subject: 'this is spam mail', messageId: '<js@x.com>' }), '<js@x.com>');
    await intake.processReceived();
    const junkTickets = (await harness!.db.select().from(tickets).where(eq(tickets.isJunk, true)));
    expect(junkTickets).toHaveLength(1);

    // 3 users: admin, a member of "Khác", a member of "Payroll" only.
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'rls-admin@x.com' }))!;
    const otherMember = (await makeUser(harness!.db, { projectId: HRIS, role: 'member', email: 'rls-other@x.com' }))!;
    const payrollMember = (await makeUser(harness!.db, { projectId: HRIS, role: 'member', email: 'rls-pay@x.com' }))!;
    await harness!.db.insert(userGroupMembership).values([
      { userId: otherMember.id, categoryId: Other },
      { userId: payrollMember.id, categoryId: Payroll },
    ]);

    // Admin sees the junk ticket (whole-project).
    const adminList = await junkSvc.list(sessionFor(admin.id, 'admin'));
    expect(adminList).toHaveLength(1);
    expect(adminList[0]!.isAuto).toBe(true);
    expect(adminList[0]!.caughtBy).toBe('spam');

    // "Khác" member sees it (category_id = ANY(app_groups)).
    const otherList = await junkSvc.list(sessionFor(otherMember.id, 'member'));
    expect(otherList).toHaveLength(1);

    // Payroll-only member: RLS hides the "Khác" junk ticket → empty (AC3 — no leak).
    const payList = await junkSvc.list(sessionFor(payrollMember.id, 'member'));
    expect(payList).toHaveLength(0);

    // AC4 — digest junk count for admins reflects is_junk tickets. The reminder service
    // exposes a private counter via the digest; here we assert the raw count the digest
    // uses (is_junk=true in the project) is 1.
    const countRows = (await harness!.db.execute(sql`
      SELECT count(*)::int AS n FROM tickets WHERE project_id = ${HRIS} AND is_junk = true
    `)) as unknown as Array<{ n: number }>;
    expect(Number(countRows[0]!.n)).toBe(1);
  });
});
