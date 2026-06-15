import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { AdminUsersService } from '../src/modules/auth/admin-users.service';
import { SessionService } from '../src/modules/auth/session.service';
import { MeService } from '../src/modules/auth/me.service';
import { ProjectContextService } from '../src/modules/auth/project-context.service';
import { categories, tickets, users, userGroupMembership } from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';

/**
 * IT-USER-001/002/003 — Story 9.2 (FR62/FR63/FR64/FR89). Create (temp password +
 * forced change), disable (history kept, sessions revoked, no delete), the role
 * ladder (SSA→Admin, Admin→TL/Member, no self-promotion), and runtime role effect
 * (capabilities reflect the new role without re-login). Needs Docker.
 */
describe('IT-USER: full user management', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const sessions = new SessionService();
  const svc = new AdminUsersService(sessions);
  const me = new MeService(new ProjectContextService());
  const HRIS = 1;
  let Payroll = 0;

  const session = (id: string, role: SessionUser['role'], projectId: number | null = HRIS): SessionUser => ({
    id,
    email: `${id}@x.com`,
    name: id,
    role,
    projectId,
    disabled: false,
    mustChangePassword: false,
  });

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      ready = true;
    } catch (e) {
      console.warn('[IT-USER] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(tickets);
      await harness!.db.execute(sql`DELETE FROM audit_log WHERE action LIKE 'user.%'`);
    }
  });

  it('IT-USER-001: create (temp password + forced change + group) and disable (history kept, session killed)', async () => {
    if (!ready) return;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'u1-adm@x.com' }))!;

    // AC1 — create a Member in the Payroll group.
    const res = await svc.createUser(session(admin.id, 'admin'), HRIS, {
      email: 'NewHire@x.com',
      name: 'New Hire',
      role: 'member',
      categoryIds: [Payroll],
    });
    expect(res.tempPassword).toBeTruthy();
    const [created] = await harness!.db.select().from(users).where(eq(users.id, res.id));
    expect(created!.role).toBe('member');
    expect(created!.mustChangePassword).toBe(true);
    expect(created!.email).toBe('newhire@x.com'); // normalised lower-case
    const mem = await harness!.db.select().from(userGroupMembership).where(eq(userGroupMembership.userId, res.id));
    expect(mem.map((m) => m.categoryId)).toEqual([Payroll]);

    // Duplicate email → 409.
    await expect(
      svc.createUser(session(admin.id, 'admin'), HRIS, { email: 'newhire@x.com', name: 'Dup', role: 'member' }),
    ).rejects.toMatchObject({ status: 409 });

    // AC2 — the new user holds a ticket + has a live session.
    const [held] = await harness!.db
      .insert(tickets)
      .values({
        projectId: HRIS,
        ticketCode: '#U00001',
        subject: 'held',
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: 'in_progress',
        assigneeId: res.id,
      })
      .returning({ id: tickets.id });
    const sid = await sessions.create(res.id);

    await svc.setDisabled(session(admin.id, 'admin'), HRIS, res.id, true);
    const [after] = await harness!.db.select().from(users).where(eq(users.id, res.id));
    expect(after!.disabled).toBe(true);
    // Held ticket still attributed to the disabled user (no delete, no reassign here).
    const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, held!.id));
    expect(t!.assigneeId).toBe(res.id);
    // Live session revoked → immediate lock-out (AC2).
    expect(await sessions.resolve(sid)).toBeNull();

    const audits = (await harness!.db.execute(sql`
      SELECT action FROM audit_log WHERE object_id = ${res.id} ORDER BY id
    `)) as unknown as Array<{ action: string }>;
    expect(audits.map((a) => a.action)).toEqual(['user.created', 'user.disabled']);
  });

  it('IT-USER-002: role ladder — Admin→TL/Member only, SSA→Admin, no self-promotion, scope', async () => {
    if (!ready) return;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'u2-adm@x.com' }))!;
    const ssa = (await makeUser(harness!.db, { projectId: HRIS, role: 'ssa', email: 'u2-ssa@x.com' }))!;
    const member = (await makeUser(harness!.db, { projectId: HRIS, role: 'member', email: 'u2-m@x.com' }))!;
    const otherAdmin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'u2-adm2@x.com' }))!;

    // Admin may assign TL/Member but NOT Admin (FR64).
    await svc.setRole(session(admin.id, 'admin'), HRIS, member.id, 'team_lead');
    expect((await harness!.db.select().from(users).where(eq(users.id, member.id)))[0]!.role).toBe('team_lead');
    await expect(
      svc.setRole(session(admin.id, 'admin'), HRIS, member.id, 'admin'),
    ).rejects.toMatchObject({ status: 403 });

    // SSA may assign Admin.
    await svc.setRole(session(ssa.id, 'ssa'), HRIS, member.id, 'admin');
    expect((await harness!.db.select().from(users).where(eq(users.id, member.id)))[0]!.role).toBe('admin');

    // Nobody promotes themselves.
    await expect(
      svc.setRole(session(admin.id, 'admin'), HRIS, admin.id, 'member'),
    ).rejects.toMatchObject({ status: 403 });

    // Admin can't touch another Admin (out of scope).
    await expect(
      svc.setRole(session(admin.id, 'admin'), HRIS, otherAdmin.id, 'member'),
    ).rejects.toMatchObject({ status: 403 });

    // Admin can't create an Admin; SSA can.
    await expect(
      svc.createUser(session(admin.id, 'admin'), HRIS, { email: 'mk-adm@x.com', name: 'x', role: 'admin' }),
    ).rejects.toMatchObject({ status: 403 });
    const ok = await svc.createUser(session(ssa.id, 'ssa'), HRIS, { email: 'ssa-mk-adm@x.com', name: 'x', role: 'admin' });
    expect(ok.id).toBeTruthy();
  });

  it('IT-USER-003: role change takes effect on the next request (capabilities, no re-login)', async () => {
    if (!ready) return;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'u3-adm@x.com' }))!;
    const m = (await makeUser(harness!.db, { projectId: HRIS, role: 'member', email: 'u3-m@x.com' }))!;
    const sid = await sessions.create(m.id);

    // Member capabilities do NOT include the team-lead "assign others" cap.
    const before = await sessions.resolve(sid);
    const mePre = await me.build(before!);
    expect(mePre.role).toBe('member');
    expect(mePre.capabilities).not.toContain('ticket.assign_others');

    // Admin promotes M → Team Lead.
    await svc.setRole(session(admin.id, 'admin'), HRIS, m.id, 'team_lead');

    // SAME session (no re-login): resolve reads the fresh role, /me reflects the new caps.
    const after = await sessions.resolve(sid);
    expect(after!.role).toBe('team_lead');
    const mePost = await me.build(after!);
    expect(mePost.capabilities).toContain('ticket.assign_others');
  });
});
