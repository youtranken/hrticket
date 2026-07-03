import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { categories, tickets, assignCursors, userGroupMembership } from '../src/infra/db/schema';
import { AdminConfigService } from '../src/modules/admin/admin-config.service';
import { classifyTicket } from '../src/modules/routing/classify.service';
import { autoAssign } from '../src/modules/routing/auto-assign.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const admin: SessionUser = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'cfg-admin@x.com',
  name: 'cfg admin',
  role: 'admin',
  projectId: 1,
  disabled: false,
  mustChangePassword: false,
};

/**
 * IT-CATCFG-001/002 — Story 4.6. Category/keyword CRUD feeds classify with no
 * restart, the system "Khác" is immutable, a category with tickets can't be
 * deleted, and editing the auto-assign config changes assignment immediately.
 */
describe('IT-CATCFG: category + auto-assign config', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new AdminConfigService();
  let Other: number;
  let Payroll: number;
  let A: string;
  let B: string;
  let C: string;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const realAdmin = (await makeUser(harness.db, { projectId: 1, role: 'admin', email: 'cfg-admin@x.com' }))!;
      admin.id = realAdmin.id;
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Other = cats.find((c) => c.nameEn === 'Other')!.id;
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      A = (await makeUser(harness.db, { projectId: 1, email: 'cfg-a@x.com' }))!.id;
      B = (await makeUser(harness.db, { projectId: 1, email: 'cfg-b@x.com' }))!.id;
      C = (await makeUser(harness.db, { projectId: 1, email: 'cfg-c@x.com' }))!.id;
      // Auto-assign roster ⊆ group members → A/B/C must be in the Payroll group first.
      await harness.db.insert(userGroupMembership).values([
        { userId: A, categoryId: Payroll },
        { userId: B, categoryId: Payroll },
        { userId: C, categoryId: Payroll },
      ]);
      ready = true;
    } catch (e) {
      console.warn('[IT-CATCFG] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  it('IT-CATCFG-001: create→classify live, "Khác" immutable, delete blocked by tickets', async () => {
    if (!ready) return;
    // Create a new category + keyword → classify picks it up with no restart (AC1).
    const { id } = await svc.createCategory(admin, 1, {
      nameVi: 'Công đoàn',
      nameEn: 'Union',
      keywords: ['công đoàn'],
    });
    const classified = await withActor(systemActor, (tx) =>
      classifyTicket(tx, 1, 'Về công đoàn', 'nội dung công đoàn'),
    );
    expect(classified.categoryId).toBe(id);

    const list = await svc.listCategories(1);
    expect(list.find((c) => c.id === id)?.keywords).toContain('công đoàn');

    // "Khác" is system → immutable for both update and delete (AC2).
    await expect(svc.updateCategory(admin, 1, Other, { nameEn: 'Hacked' })).rejects.toThrow();
    await expect(svc.deleteCategory(admin, 1, Other)).rejects.toThrow();

    // A category with tickets cannot be deleted — only disabled (AC2).
    await harness!.db.insert(tickets).values({
      projectId: 1,
      ticketCode: '#G00001',
      subject: 's',
      requesterEmail: 'r@x.com',
      mailbox: 'hris@test.local',
      categoryId: id,
      status: 'open',
    });
    await expect(svc.deleteCategory(admin, 1, id)).rejects.toThrow();
    await svc.updateCategory(admin, 1, id, { disabled: true }); // disable is allowed
    expect((await svc.listCategories(1)).find((c) => c.id === id)?.disabled).toBe(true);

    // A fresh, ticket-less category deletes cleanly.
    const tmp = await svc.createCategory(admin, 1, { nameVi: 'Tạm', nameEn: 'Temp' });
    await expect(svc.deleteCategory(admin, 1, tmp.id)).resolves.toMatchObject({ ok: true });
  });

  it('IT-CATCFG-002: editing the auto-assign config changes assignment immediately', async () => {
    if (!ready) return;
    const freshTicket = async (): Promise<string> => {
      const [row] = await harness!.db
        .insert(tickets)
        .values({
          projectId: 1,
          ticketCode: `#G${Math.floor(Math.random() * 90000) + 10000}`,
          subject: 's',
          requesterEmail: 'r@x.com',
          mailbox: 'hris@test.local',
          categoryId: Payroll,
          status: 'open',
        })
        .returning({ id: tickets.id });
      return row!.id;
    };
    const assign = (tid: string) =>
      withActor(systemActor, (tx) =>
        autoAssign(tx, { projectId: 1, ticketId: tid, ticketCode: '#x', categoryId: Payroll }),
      );

    // Roster A,B,C round-robin.
    await svc.putAutoAssign(admin, 1, Payroll, { strategy: 'round_robin', members: [A, B, C] });
    const first = await assign(await freshTicket());
    expect([A, B, C]).toContain(first.assigneeId);

    // Re-configure: least-load, drop C. Effective immediately, no cache (AC3).
    await harness!.db.delete(assignCursors);
    await svc.putAutoAssign(admin, 1, Payroll, { strategy: 'least_load', members: [A, B] });
    const picks: (string | null)[] = [];
    for (let i = 0; i < 4; i++) picks.push((await assign(await freshTicket())).assigneeId);
    expect(picks).not.toContain(C); // C was removed → never assigned
    expect(picks.every((p) => p === A || p === B)).toBe(true);
  });
});
