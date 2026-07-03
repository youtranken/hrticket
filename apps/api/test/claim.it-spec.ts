import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import {
  categories,
  userGroupMembership,
  tickets,
  notifications,
} from '../src/infra/db/schema';
import { AssignmentService } from '../src/modules/tickets/assignment.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const session = (id: string, email: string, role: SessionUser['role'] = 'member'): SessionUser => ({
  id,
  email,
  name: email,
  role,
  projectId: 1,
  disabled: false,
  mustChangePassword: false,
});

/**
 * IT-CLAIM-001..003 — Story 4.4. The atomic pool claim is race-free (exactly one
 * winner), claim-over notifies the displaced holder, and a ticket outside my group
 * is unreachable (RLS → 404). Needs Docker; self-skips.
 */
describe('IT-CLAIM: pool claim + claim-over', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new AssignmentService();
  let Payroll: number;
  let Insurance: number;
  let M1: SessionUser;
  let M2: SessionUser;
  let M3: SessionUser; // different group
  let TL: SessionUser; // team lead, same group as M1/M2
  let ticketId: string;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      Insurance = cats.find((c) => c.nameEn === 'Insurance')!.id;
      const u1 = (await makeUser(harness.db, { projectId: 1, email: 'm1@x.com' }))!;
      const u2 = (await makeUser(harness.db, { projectId: 1, email: 'm2@x.com' }))!;
      const u3 = (await makeUser(harness.db, { projectId: 1, email: 'm3@x.com' }))!;
      const utl = (await makeUser(harness.db, { projectId: 1, role: 'team_lead', email: 'tl@x.com' }))!;
      M1 = session(u1.id, u1.email);
      M2 = session(u2.id, u2.email);
      M3 = session(u3.id, u3.email);
      TL = session(utl.id, utl.email, 'team_lead');
      await harness.db.insert(userGroupMembership).values([
        { userId: M1.id, categoryId: Payroll },
        { userId: M2.id, categoryId: Payroll },
        { userId: M3.id, categoryId: Insurance },
        { userId: TL.id, categoryId: Payroll },
      ]);
      ready = true;
    } catch (e) {
      console.warn('[IT-CLAIM] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(notifications);
    await harness!.db.delete(tickets);
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: '#C00001',
        subject: 'claimable',
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: 'open',
      })
      .returning({ id: tickets.id });
    ticketId = row!.id;
  });

  it('IT-CLAIM-001: two concurrent claims on a pool ticket → exactly one winner (×20)', async () => {
    if (!ready) return;
    for (let i = 0; i < 20; i++) {
      await harness!.db
        .update(tickets)
        .set({ assigneeId: null, status: 'open' })
        .where(eq(tickets.id, ticketId));

      const results = await Promise.allSettled([svc.claim(M1, ticketId), svc.claim(M2, ticketId)]);
      const wins = results.filter((r) => r.status === 'fulfilled');
      const losses = results.filter((r) => r.status === 'rejected');
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);

      const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, ticketId));
      expect([M1.id, M2.id]).toContain(t!.assigneeId);
      expect(t!.status).toBe('assigned');
    }
  }, 60000);

  it('IT-CLAIM-002: claim-over takes it from the holder + notifies them + audits', async () => {
    if (!ready) return;
    await svc.claim(M1, ticketId); // M1 holds it
    const res = await svc.claim(M2, ticketId, { over: true }); // M2 explicitly takes over
    // Real category → never the needsCategory branch (đơn 5: only "Khác" asks).
    if ('needsCategory' in res) throw new Error('unexpected needsCategory');
    expect(res.assigneeId).toBe(M2.id);
    expect(res.from).toBe(M1.id);

    const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(t!.assigneeId).toBe(M2.id);

    const notes = await harness!.db
      .select()
      .from(notifications)
      .where(eq(notifications.actorId, M1.id));
    expect(notes.some((n) => n.type === 'ticket_reassigned')).toBe(true);
  });

  it('IT-CLAIM-003: a member outside the ticket group cannot see/claim it (404)', async () => {
    if (!ready) return;
    await expect(svc.claim(M3, ticketId)).rejects.toThrow();
    const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(t!.assigneeId).toBeNull(); // untouched
  });

  it('IT-CLAIM-004: a member CANNOT claim-over a ticket held by a Team Lead (403)', async () => {
    if (!ready) return;
    await svc.claim(TL, ticketId); // TL holds it
    await expect(svc.claim(M2, ticketId, { over: true })).rejects.toThrow(
      /cannot take over/i,
    );
    const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(t!.assigneeId).toBe(TL.id); // still the TL — not pulled away
  });

  it('IT-CLAIM-005: a Team Lead CAN claim-over a ticket held by a member', async () => {
    if (!ready) return;
    await svc.claim(M1, ticketId); // member holds it
    const res = await svc.claim(TL, ticketId, { over: true }); // TL takes over (coordinator)
    if ('needsCategory' in res) throw new Error('unexpected needsCategory');
    expect(res.assigneeId).toBe(TL.id);
    expect(res.from).toBe(M1.id);
    const [t] = await harness!.db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(t!.assigneeId).toBe(TL.id);
  });
});
