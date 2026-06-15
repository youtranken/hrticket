import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import {
  categories,
  userGroupMembership,
  tickets,
  participants,
  ticketMessages,
  notifications,
  outbox,
  blocklist,
} from '../src/infra/db/schema';
import { JunkService } from '../src/modules/junk/junk.service';
import { handleReplyTransition } from '../src/modules/intake/reopen.usecase';
import type { SessionUser } from '../src/modules/auth/session.service';

const REQ = 'req@x.com';

/**
 * IT-MSPAM-001/002 — Story 7.4. Manual "Đánh dấu Rác" (close + is_junk, KEEP original
 * category, optional block, permission matrix) and "Đánh dấu Spam thread" (is_spam_thread
 * toggle → replies fully silent; spam wins over locked). Needs Docker; self-skips.
 */
describe('IT-MSPAM: manual mark Rác / Spam thread', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new JunkService();
  let Payroll = 0;
  let Other = 0;
  let assignee: SessionUser;
  let teamLead: SessionUser;
  let admin: SessionUser;
  let outsider: SessionUser; // member NOT in Payroll
  let poolMember: SessionUser; // member in Payroll

  const session = (id: string, email: string, role: SessionUser['role']): SessionUser => ({
    id, email, name: email, role, projectId: 1, disabled: false, mustChangePassword: false,
  });

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      Other = cats.find((c) => c.nameEn === 'Other')!.id;
      const a = (await makeUser(harness.db, { projectId: 1, email: 'ms-assignee@x.com' }))!;
      const tl = (await makeUser(harness.db, { projectId: 1, role: 'team_lead', email: 'ms-tl@x.com' }))!;
      const ad = (await makeUser(harness.db, { projectId: 1, role: 'admin', email: 'ms-admin@x.com' }))!;
      const out = (await makeUser(harness.db, { projectId: 1, email: 'ms-out@x.com' }))!;
      const pool = (await makeUser(harness.db, { projectId: 1, email: 'ms-pool@x.com' }))!;
      assignee = session(a.id, a.email, 'member');
      teamLead = session(tl.id, tl.email, 'team_lead');
      admin = session(ad.id, ad.email, 'admin');
      outsider = session(out.id, out.email, 'member');
      poolMember = session(pool.id, pool.email, 'member');
      await harness.db.insert(userGroupMembership).values([
        { userId: a.id, categoryId: Payroll },
        { userId: tl.id, categoryId: Payroll },
        { userId: pool.id, categoryId: Payroll },
        { userId: out.id, categoryId: Other },
      ]);
      ready = true;
    } catch (e) {
      console.warn('[IT-MSPAM] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(participants);
    await harness!.db.delete(ticketMessages);
    await harness!.db.delete(notifications);
    await harness!.db.delete(outbox);
    await harness!.db.delete(tickets);
    await harness!.db.delete(blocklist);
  });

  let seq = 0;
  async function makeTicket(opts: {
    status?: string;
    assigneeId?: string | null;
    isSpamThread?: boolean;
    reopenLocked?: boolean;
  }): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#M${String(seq).padStart(5, '0')}`,
        subject: 'ad mail',
        requesterEmail: REQ,
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: (opts.status ?? 'open') as 'open',
        assigneeId: opts.assigneeId ?? null,
        isSpamThread: opts.isSpamThread ?? false,
        reopenLocked: opts.reopenLocked ?? false,
        lastOpenedAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning({ id: tickets.id });
    // requester is an active participant (drives reply transitions).
    await harness!.db.insert(participants).values({ ticketId: row!.id, email: REQ, status: 'active' });
    return row!.id;
  }

  const load = async (id: string) =>
    (await harness!.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

  const fireReply = (ticketId: string) =>
    withActor(systemActor, (tx) =>
      handleReplyTransition(tx, {
        ticketId,
        projectId: 1,
        fromAddr: REQ,
        fromIsActiveParticipant: true,
        isAutoReply: false,
      }),
    );

  it('IT-MSPAM-001: mark Rác keeps category, blocks sender; permission matrix', async () => {
    if (!ready) return;
    // assignee marks their In Progress ticket Rác + block sender.
    const t = await makeTicket({ status: 'in_progress', assigneeId: assignee.id });
    const res = await svc.markJunk(assignee, t, { blockSender: true });
    expect(res.blocked).toBe(true);

    const after = await load(t);
    expect(after.status).toBe('closed');
    expect(after.isJunk).toBe(true);
    expect(after.categoryId).toBe(Payroll); // KEPT original category (not "Khác")
    expect(after.junkedFromCategoryId).toBe(Payroll);
    expect(after.assigneeId).toBe(assignee.id); // assignee kept
    const block = await harness!.db.select().from(blocklist).where(eq(blocklist.email, REQ));
    expect(block).toHaveLength(1);

    // Manual junk surfaces in the Junk tab as "manual" (isAuto=false), visible to Admin.
    const adminJunk = await svc.list(admin);
    const row = adminJunk.find((j) => j.id === t);
    expect(row).toBeDefined();
    expect(row!.isAuto).toBe(false);

    // Permission matrix (AC3).
    const tlTicket = await makeTicket({ status: 'open', assigneeId: assignee.id });
    await expect(svc.markJunk(teamLead, tlTicket, {})).resolves.toMatchObject({ ok: true }); // TL of group
    const adminTicket = await makeTicket({ status: 'open', assigneeId: assignee.id });
    await expect(svc.markJunk(admin, adminTicket, {})).resolves.toMatchObject({ ok: true }); // Admin
    // Member on someone-else's ASSIGNED ticket → 403.
    const assignedToOther = await makeTicket({ status: 'in_progress', assigneeId: assignee.id });
    await expect(svc.markJunk(outsider, assignedToOther, {})).rejects.toThrow();
    // Member in the group on a POOLED ticket → allowed (M3).
    const pooled = await makeTicket({ status: 'open', assigneeId: null });
    await expect(svc.markJunk(poolMember, pooled, {})).resolves.toMatchObject({ ok: true });
    expect((await load(pooled)).isJunk).toBe(true);
  });

  it('IT-MSPAM-001b: release manual junk restores category + status, no re-ack', async () => {
    if (!ready) return;
    const t = await makeTicket({ status: 'in_progress', assigneeId: assignee.id });
    await svc.markJunk(assignee, t, {});
    expect((await load(t)).status).toBe('closed');

    const rel = await svc.release(admin, t);
    expect(rel.reAcked).toBe(false); // manual junk does NOT re-ack (M4)
    const after = await load(t);
    expect(after.isJunk).toBe(false);
    expect(after.categoryId).toBe(Payroll);
    expect(after.junkedFromCategoryId).toBeNull();
    expect(after.status).toBe('in_progress'); // restored pre-junk status
    expect(await harness!.db.select().from(outbox)).toHaveLength(0); // no ack mail
  });

  it('IT-MSPAM-002: spam thread → replies silent; un-toggle restores; spam beats locked', async () => {
    if (!ready) return;
    // In Progress ticket marked spam-thread.
    const t = await makeTicket({ status: 'in_progress', assigneeId: assignee.id });
    const m = await svc.toggleSpamThread(assignee, t, true);
    expect(m.isSpamThread).toBe(true);

    // 3 participant replies → each fully silent (no wake/bump/notify).
    for (let i = 0; i < 3; i++) {
      const r = await fireReply(t);
      expect(r.action).toBe('spam_silent');
    }
    const after = await load(t);
    expect(after.status).toBe('in_progress'); // unchanged
    expect(after.reopenCount).toBe(0); // no bump
    expect(await harness!.db.select().from(notifications)).toHaveLength(0); // no notify

    // Un-toggle → a later reply behaves normally (this open ticket is not pending/closed,
    // so the normal path is append_only — but it's NOT spam_silent anymore).
    await svc.toggleSpamThread(assignee, t, false);
    const r2 = await fireReply(t);
    expect(r2.action).not.toBe('spam_silent');

    // Precedence (M7): a CLOSED + locked + spam ticket reply → silent, NO contact-HR notice.
    const locked = await makeTicket({ status: 'closed', assigneeId: assignee.id, reopenLocked: true, isSpamThread: true });
    const r3 = await fireReply(locked);
    expect(r3.action).toBe('spam_silent');
    // No locked-notice mail enqueued.
    expect(await harness!.db.select().from(outbox)).toHaveLength(0);
  });
});
