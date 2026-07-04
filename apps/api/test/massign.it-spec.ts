import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor } from '../src/infra/db/with-actor';
import { categories, userGroupMembership, tickets, users } from '../src/infra/db/schema';
import { AssignmentService } from '../src/modules/tickets/assignment.service';
import { actorForUser } from '../src/modules/tickets/actor';
import type { SessionUser } from '../src/modules/auth/session.service';
import type { Role } from '../src/infra/db/schema';

const sess = (id: string, email: string, role: Role, projectId: number | null): SessionUser => ({
  id,
  email,
  name: email,
  role,
  projectId,
  disabled: false,
  mustChangePassword: false,
});

/**
 * IT-MASSIGN-001..003 — Story 4.5. Permission matrix for manual assign, "Khác"
 * re-classification by the assignee's groups (1 / many / none) with a real RLS
 * visibility flip, ignore-availability + attribution chain. Needs Docker.
 */
describe('IT-MASSIGN: manual assign + reclassify', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new AssignmentService();
  let Payroll: number;
  let Insurance: number;
  let Other: number;
  // Actors.
  let member: SessionUser;
  let tlPay: SessionUser;
  let tlIns: SessionUser;
  let adminHris: SessionUser;
  let adminCnb: SessionUser;
  let ssa: SessionUser;
  let memberIns: SessionUser;
  // Assignment targets (plain ids).
  let t1: string; // 1 group (Payroll)
  let t2: string; // 2 groups (Payroll + Insurance)
  let t3: string; // no group
  let awayId: string;
  let disabledId: string;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      Insurance = cats.find((c) => c.nameEn === 'Insurance')!.id;
      Other = cats.find((c) => c.nameEn === 'Other')!.id;

      const mk = async (email: string, role: Role, projectId: number, groups: number[] = [], disabled = false) => {
        const u = (await makeUser(harness!.db, { projectId, role, email, disabled }))!;
        for (const g of groups) await harness!.db.insert(userGroupMembership).values({ userId: u.id, categoryId: g });
        return u.id;
      };

      member = sess(await mk('ma-member@x.com', 'member', 1, [Payroll]), 'ma-member@x.com', 'member', 1);
      tlPay = sess(await mk('ma-tlpay@x.com', 'team_lead', 1, [Payroll]), 'ma-tlpay@x.com', 'team_lead', 1);
      tlIns = sess(await mk('ma-tlins@x.com', 'team_lead', 1, [Insurance]), 'ma-tlins@x.com', 'team_lead', 1);
      adminHris = sess(await mk('ma-admin@x.com', 'admin', 1), 'ma-admin@x.com', 'admin', 1);
      adminCnb = sess(await mk('ma-admincnb@x.com', 'admin', 2), 'ma-admincnb@x.com', 'admin', 2);
      ssa = sess(await mk('ma-ssa@x.com', 'ssa', 1), 'ma-ssa@x.com', 'ssa', 1);
      memberIns = sess(await mk('ma-memberins@x.com', 'member', 1, [Insurance]), 'ma-memberins@x.com', 'member', 1);

      t1 = await mk('ma-t1@x.com', 'member', 1, [Payroll]);
      t2 = await mk('ma-t2@x.com', 'member', 1, [Payroll, Insurance]);
      t3 = await mk('ma-t3@x.com', 'member', 1, []);
      awayId = await mk('ma-away@x.com', 'member', 1, [Payroll]);
      disabledId = await mk('ma-disabled@x.com', 'member', 1, [Payroll], true);
      await harness.db
        .update(users)
        .set({ awayFrom: '2026-06-01', awayTo: '2030-01-01' })
        .where(eq(users.id, awayId));
      ready = true;
    } catch (e) {
      console.warn('[IT-MASSIGN] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  async function mkTicket(categoryId: number, assigneeId: string | null = null): Promise<string> {
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#M${Math.floor(Math.random() * 90000) + 10000}`,
        subject: 's',
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId,
        status: assigneeId ? 'assigned' : 'open',
        assigneeId,
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  it('IT-MASSIGN-001: assign permission matrix (member/TL/admin/SSA × project)', async () => {
    if (!ready) return;
    const mk = () => mkTicket(Payroll);

    await expect(svc.assign(member, await mk(), { assigneeId: t1 })).rejects.toThrow(); // member 403
    await expect(svc.assign(tlIns, await mk(), { assigneeId: t1 })).rejects.toThrow(); // TL other group 403
    await expect(svc.assign(adminCnb, await mk(), { assigneeId: t1 })).rejects.toThrow(); // cnb admin → 404

    await expect(svc.assign(tlPay, await mk(), { assigneeId: t1 })).resolves.toMatchObject({ assigneeId: t1 });
    await expect(svc.assign(adminHris, await mk(), { assigneeId: t1 })).resolves.toMatchObject({ assigneeId: t1 });
    await expect(svc.assign(ssa, await mk(), { assigneeId: t1 })).resolves.toMatchObject({ assigneeId: t1 });
  });

  it('IT-MASSIGN-002: re-classify "Khác" (1 / many / none) + visibility flip + disabled 422', async () => {
    if (!ready) return;
    // 1 group → category auto-becomes Payroll.
    const tk1 = await mkTicket(Other);
    await expect(svc.assign(adminHris, tk1, { assigneeId: t1 })).resolves.toMatchObject({
      assigneeId: t1,
      categoryId: Payroll,
    });

    // Visibility flips with the category: a Payroll member sees it, an Insurance member does not.
    const seenBy = async (u: SessionUser, tid: string) =>
      withActor(await actorForUser(u), (tx) =>
        tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, tid)),
      );
    expect(await seenBy(member, tk1)).toHaveLength(1);
    expect(await seenBy(memberIns, tk1)).toHaveLength(0);

    // Many groups → must choose; then the chosen category sticks.
    const tk2 = await mkTicket(Other);
    const ambiguous = await svc.assign(adminHris, tk2, { assigneeId: t2 });
    expect('needsCategory' in ambiguous && ambiguous.needsCategory).toBe(true);
    if ('options' in ambiguous) {
      expect(ambiguous.options.map((o) => o.id).sort()).toEqual([Payroll, Insurance].sort());
    }
    await expect(svc.assign(adminHris, tk2, { assigneeId: t2, categoryId: Insurance })).resolves.toMatchObject({
      categoryId: Insurance,
    });

    // No group → stays "Khác".
    const tk3 = await mkTicket(Other);
    await expect(svc.assign(adminHris, tk3, { assigneeId: t3 })).resolves.toMatchObject({
      assigneeId: t3,
      categoryId: Other,
    });

    // Disabled target → 422 (M11).
    const tk4 = await mkTicket(Payroll);
    await expect(svc.assign(adminHris, tk4, { assigneeId: disabledId })).rejects.toThrow();
  });

  it('IT-MASSIGN-003: assign ignores availability (AC1); reassign keeps the A→B chain (AC4)', async () => {
    if (!ready) return;
    // AC1: assigning to an away user still works; their availability is untouched.
    const tk = await mkTicket(Payroll);
    await expect(svc.assign(tlPay, tk, { assigneeId: awayId })).resolves.toMatchObject({ assigneeId: awayId });
    const [awayRow] = await harness!.db.select().from(users).where(eq(users.id, awayId));
    expect(awayRow!.awayFrom).toBeTruthy(); // unchanged

    // AC4: reassign A→B; assignee ends at B and the audit chain records both.
    await svc.assign(adminHris, tk, { assigneeId: t1 }); // → A (t1)
    await svc.assign(adminHris, tk, { assigneeId: t2, categoryId: Payroll }); // → B (t2)
    const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, tk));
    expect(t!.assigneeId).toBe(t2);
    const audits = (await harness!.db.execute(sql`
      SELECT old_value, new_value FROM audit_log
      WHERE action = 'ticket.assigned' AND object_id = ${tk}
      ORDER BY created_at ASC`)) as unknown as Array<{
      old_value: { assigneeId: string | null };
      new_value: { assigneeId: string };
    }>;
    const chain = audits.map((a) => a.new_value.assigneeId);
    expect(chain).toContain(t1);
    expect(chain[chain.length - 1]).toBe(t2);
  });

  it('IT-MASSIGN-004 (CR-4): PENDING is reassignable — status + snooze kept; terminal still 409', async () => {
    if (!ready) return;
    // A snoozed ticket whose holder went on leave: the TL hands it to a teammate.
    const tk = await mkTicket(Payroll, t1);
    await harness!.db
      .update(tickets)
      .set({ status: 'pending', snoozeUntil: '2027-01-15' })
      .where(eq(tickets.id, tk));

    await expect(svc.assign(tlPay, tk, { assigneeId: t2 })).resolves.toMatchObject({ assigneeId: t2 });
    const [row] = await harness!.db.select().from(tickets).where(eq(tickets.id, tk));
    expect(row!.assigneeId).toBe(t2);
    expect(row!.status).toBe('pending'); // NOT forced to in_progress
    expect(row!.snoozeUntil).toBe('2027-01-15'); // follow-up date inherited

    // Terminal states stay rejected.
    await harness!.db.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, tk));
    await expect(svc.assign(tlPay, tk, { assigneeId: t1 })).rejects.toThrow('INVALID_TRANSITION');
  });

  it('IT-MASSIGN-005: bulk-assign endpoint — partial success with per-ticket verdicts', async () => {
    if (!ready) return;
    const { BulkAssignController } = await import('../src/modules/tickets/assignment.controller');
    const ctrl = new BulkAssignController(svc);

    const okA = await mkTicket(Payroll); // assignable
    const okB = await mkTicket(Payroll); // assignable
    const closed = await mkTicket(Payroll); // terminal → per-ticket failure
    await harness!.db.update(tickets).set({ status: 'closed' }).where(eq(tickets.id, closed));

    const res = (await ctrl.bulkAssign(tlPay, {
      ticketIds: [okA, okB, closed],
      assigneeId: t1,
    })) as { results: Array<{ ticketId: string; ok: boolean; error?: string }> };

    expect(res.results).toHaveLength(3);
    expect(res.results.filter((r) => r.ok).map((r) => r.ticketId).sort()).toEqual([okA, okB].sort());
    const failed = res.results.find((r) => r.ticketId === closed)!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeTruthy();
    // The two successes really landed (manual assign → in_progress, đơn 5 model).
    for (const id of [okA, okB]) {
      const [row] = await harness!.db.select().from(tickets).where(eq(tickets.id, id));
      expect(row!.assigneeId).toBe(t1);
      expect(row!.status).toBe('in_progress');
    }
    // The closed one was untouched — a mid-list failure never poisons the batch.
    const [closedRow] = await harness!.db.select().from(tickets).where(eq(tickets.id, closed));
    expect(closedRow!.assigneeId).toBeNull();
    expect(closedRow!.status).toBe('closed');

    // Malformed payload → 400 (zod boundary).
    await expect(ctrl.bulkAssign(tlPay, { ticketIds: [], assigneeId: t1 })).rejects.toMatchObject({
      status: 400,
    });
  });
});
