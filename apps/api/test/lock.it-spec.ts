import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { categories, userGroupMembership, tickets, outbox } from '../src/infra/db/schema';
import { handleReplyTransition } from '../src/modules/intake/reopen.usecase';
import { ReopenLockService } from '../src/modules/tickets/reopen-lock.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const REQ = 'req@x.com';
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
 * IT-LOCK-001/002 — Story 5.4. Reopen 1–5 are normal; the 6th still reopens but
 * raises the warn flag; once a human ticks Lock, replies append + notify "contact HR"
 * (no bump); untick restores reopen. Only assignee/TL/Admin may lock. Needs Docker.
 */
describe('IT-LOCK: reopen lock lifecycle', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const lockSvc = new ReopenLockService();
  let Payroll: number;
  let A: SessionUser; // assignee
  let B: SessionUser; // member, same group, not assignee
  let Admin: SessionUser;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      const a = (await makeUser(harness.db, { projectId: 1, email: 'a-lock@x.com' }))!;
      const b = (await makeUser(harness.db, { projectId: 1, email: 'b-lock@x.com' }))!;
      const adm = (await makeUser(harness.db, { projectId: 1, email: 'adm-lock@x.com', role: 'admin' }))!;
      A = session(a.id, a.email);
      B = session(b.id, b.email);
      Admin = session(adm.id, adm.email, 'admin');
      await harness.db.insert(userGroupMembership).values([
        { userId: A.id, categoryId: Payroll },
        { userId: B.id, categoryId: Payroll },
      ]);
      ready = true;
    } catch (e) {
      console.warn('[IT-LOCK] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  let seq = 0;
  async function makeClosed(reopenCount = 0): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#K${String(seq).padStart(5, '0')}`,
        subject: 'lock me',
        requesterEmail: REQ,
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: 'closed',
        assigneeId: A.id,
        reopenCount,
      })
      .returning({ id: tickets.id });
    return row!.id;
  }
  const reClose = (id: string) => harness!.db.update(tickets).set({ status: 'closed' }).where(eq(tickets.id, id));
  const fire = (id: string, isAutoReply = false) =>
    withActor(systemActor, (tx) =>
      handleReplyTransition(tx, {
        ticketId: id,
        projectId: 1,
        fromAddr: REQ,
        fromIsActiveParticipant: true,
        isAutoReply,
      }),
    );
  const load = async (id: string) =>
    (await harness!.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

  it('IT-LOCK-001: 5 normal reopens → 6th warns → lock → notice-only → unlock → reopen again', async () => {
    if (!ready) return;
    const t = await makeClosed(0);
    // Reopen 1..6, re-closing between each. All reopen normally (no auto-lock).
    for (let i = 1; i <= 6; i++) {
      const res = await fire(t);
      expect(res.action).toBe('reopened_assignee');
      expect((await load(t)).reopenCount).toBe(i);
      await reClose(t);
    }
    expect((await load(t)).reopenCount).toBe(6); // count > WARN(5) → UI shows the tickbox

    // A human ticks Lock.
    await lockSvc.setLock(A, t, true);
    expect((await load(t)).reopenLocked).toBe(true);

    // Now a reply appends + sends the notice, does NOT reopen or bump.
    const r = await fire(t);
    expect(r.action).toBe('locked_notice');
    expect((await load(t)).status).toBe('closed');
    expect((await load(t)).reopenCount).toBe(6);
    expect((await harness!.db.select().from(outbox).where(eq(outbox.ticketId, t))).length).toBe(1);

    // Untick → replies reopen again.
    await lockSvc.setLock(A, t, false);
    const r2 = await fire(t);
    expect(r2.action).toBe('reopened_assignee');
    expect((await load(t)).reopenCount).toBe(7);
  });

  it('IT-LOCK-002: only assignee/TL/Admin may lock; auto-reply on a locked ticket sends no notice', async () => {
    if (!ready) return;
    const t = await makeClosed(6);
    // AC3 — a Member who is not the assignee cannot lock.
    await expect(lockSvc.setLock(B, t, true)).rejects.toMatchObject({ status: 403 });
    // assignee + admin can.
    await lockSvc.setLock(A, t, true);
    expect((await load(t)).reopenLocked).toBe(true);
    await lockSvc.setLock(Admin, t, false);
    expect((await load(t)).reopenLocked).toBe(false);

    // AC4 — auto-submitted reply on a locked ticket: no notice (anti-loop).
    await lockSvc.setLock(A, t, true);
    await harness!.db.delete(outbox);
    await fire(t, true);
    expect((await harness!.db.select().from(outbox).where(eq(outbox.ticketId, t))).length).toBe(0);
  });
});
