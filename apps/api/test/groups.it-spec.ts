import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor } from '../src/infra/db/with-actor';
import { actorForUser } from '../src/modules/tickets/actor';
import { categories, tickets, userGroupMembership } from '../src/infra/db/schema';
import { AdminGroupsService } from '../src/modules/admin/admin-groups.service';
import { AdminGroupsController } from '../src/modules/admin/admin-groups.controller';
import { ProjectContextService } from '../src/modules/auth/project-context.service';
import type { SessionUser } from '../src/modules/auth/session.service';

/**
 * IT-GROUP-001/002/003 — Story 9.1 (FR57/FR58/FR61). Assigning a user to a category
 * group changes their ticket visibility on the NEXT request (RLS reads membership
 * fresh, no re-login); none-until-granted; removal drops other-group tickets at once
 * but keeps work-in-progress (assignee carve-out); Admin is project-scoped + audited.
 * Needs Docker.
 */
describe('IT-GROUP: category-group membership', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new AdminGroupsService();
  const HRIS = 1;
  let Payroll = 0;
  let Leave = 0;

  const session = (id: string, role: SessionUser['role'] = 'member', projectId = HRIS): SessionUser => ({
    id,
    email: `${id}@x.com`,
    name: id,
    role,
    projectId,
    disabled: false,
    mustChangePassword: false,
  });

  /** Tickets the user can actually SELECT under RLS (role app + their live groups). */
  async function visibleTickets(u: SessionUser): Promise<string[]> {
    const ctx = await actorForUser(u);
    return withActor(ctx, async (tx) => {
      const rows = await tx.select({ id: tickets.id }).from(tickets);
      return rows.map((r) => r.id);
    });
  }

  let seq = 0;
  async function makeTicket(
    categoryId: number,
    assigneeId: string | null,
    status: 'open' | 'assigned' | 'in_progress' | 'pending' | 'resolved' | 'closed' = 'open',
  ): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: HRIS,
        ticketCode: `#G${String(seq).padStart(5, '0')}`,
        subject: 'group vis',
        requesterEmail: 'req@x.com',
        mailbox: 'hris@test.local',
        categoryId,
        status,
        assigneeId,
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      Leave = cats.find((c) => c.nameEn === 'Leave')!.id;
      ready = true;
    } catch (e) {
      console.warn('[IT-GROUP] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(tickets);
      await harness!.db.delete(userGroupMembership);
      await harness!.db.execute(sql`DELETE FROM audit_log WHERE action LIKE 'group.%'`);
    }
  });

  it('IT-GROUP-001: none-until-granted, then assign → visible next request (no re-login)', async () => {
    if (!ready) return;
    const m = (await makeUser(harness!.db, { projectId: HRIS, email: 'g1-m@x.com' }))!;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'g1-adm@x.com' }))!;
    const payTicket = await makeTicket(Payroll, null);
    const leaveTicket = await makeTicket(Leave, null);

    // AC3 — brand-new user with no group sees nothing.
    expect(await visibleTickets(session(m.id))).toEqual([]);

    // Admin grants Payroll → the SAME session (no re-login) now sees the Payroll ticket.
    await svc.setMembers(session(admin.id, 'admin'), HRIS, Payroll, [m.id]);
    expect(await visibleTickets(session(m.id))).toEqual([payTicket]);

    // Grant a second group → both categories visible (1 user, n groups — FR58).
    await svc.setMembers(session(admin.id, 'admin'), HRIS, Leave, [m.id]);
    const vis = await visibleTickets(session(m.id));
    expect(vis.sort()).toEqual([payTicket, leaveTicket].sort());

    // Member count reflects the grant.
    const groups = await svc.listGroups(HRIS);
    expect(groups.find((g) => g.categoryId === Payroll)!.memberCount).toBe(1);
  });

  it('IT-GROUP-002: removal drops other-group tickets at once, keeps work-in-progress', async () => {
    if (!ready) return;
    const m = (await makeUser(harness!.db, { projectId: HRIS, email: 'g2-m@x.com' }))!;
    const other = (await makeUser(harness!.db, { projectId: HRIS, email: 'g2-o@x.com' }))!;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'g2-adm@x.com' }))!;
    await svc.setMembers(session(admin.id, 'admin'), HRIS, Payroll, [m.id, other.id]);

    const mine = await makeTicket(Payroll, m.id, 'in_progress'); // #5 — M holds it
    const theirs = await makeTicket(Payroll, other.id, 'in_progress'); // #6 — someone else holds it

    // M (in Payroll) sees both.
    expect((await visibleTickets(session(m.id))).sort()).toEqual([mine, theirs].sort());

    // Admin removes M from Payroll (keep `other` in the group).
    await svc.setMembers(session(admin.id, 'admin'), HRIS, Payroll, [other.id]);

    // AC2 — #6 vanishes immediately; #5 stays (assignee carve-out / keep work-in-progress).
    expect(await visibleTickets(session(m.id))).toEqual([mine]);
    // `other` still sees both (still a member).
    expect((await visibleTickets(session(other.id))).sort()).toEqual([mine, theirs].sort());
  });

  it('IT-GROUP-003: Admin scope (cross-project rejected + audit) + role gate', async () => {
    if (!ready) return;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'g3-adm@x.com' }))!;
    const foreigner = (await makeUser(harness!.db, { projectId: 2, email: 'g3-cnb@x.com' }))!;

    // A user from another project can't be assigned to this project's group (422).
    await expect(
      svc.setMembers(session(admin.id, 'admin'), HRIS, Payroll, [foreigner.id]),
    ).rejects.toMatchObject({ status: 422 });

    // A real grant writes an audit row with old→new diff.
    const m = (await makeUser(harness!.db, { projectId: HRIS, email: 'g3-m@x.com' }))!;
    await svc.setMembers(session(admin.id, 'admin'), HRIS, Payroll, [m.id]);
    const audits = (await harness!.db.execute(sql`
      SELECT action, new_value->'added' AS added FROM audit_log WHERE action = 'group.members_set'
    `)) as unknown as Array<{ action: string; added: string[] }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.added).toEqual([m.id]);

    // AC4 — TL/Member can't reach the admin surface at all (controller role gate).
    const controller = new AdminGroupsController(svc, new ProjectContextService());
    await expect(controller.listGroups(session(m.id, 'member'))).rejects.toMatchObject({ status: 403 });
    await expect(controller.listGroups(session(m.id, 'team_lead'))).rejects.toMatchObject({ status: 403 });
  });
});
