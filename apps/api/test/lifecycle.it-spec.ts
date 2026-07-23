import { and, eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import {
  categories,
  userGroupMembership,
  tickets,
  ticketMessages,
  outbox,
} from '../src/infra/db/schema';
import { TicketStatusService } from '../src/modules/tickets/ticket-status.service';
import { ReplyService } from '../src/modules/tickets/reply.service';
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
 * IT-STATE-001 (5.1 AC2/AC4) + IT-CLOSE-001/002 (5.2). The state machine is the
 * server-side gate: illegal jumps 409 with no write, a non-assignee Member is 403,
 * and Reply & Close writes message + outbox + Closed atomically (or, when the close
 * is illegal, sends nothing at all). Needs Docker; self-skips.
 */
describe('IT-STATE / IT-CLOSE: lifecycle transitions + reply&close', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const statusSvc = new TicketStatusService();
  const replySvc = new ReplyService();
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
      const a = (await makeUser(harness.db, { projectId: 1, email: 'a-life@x.com' }))!;
      const b = (await makeUser(harness.db, { projectId: 1, email: 'b-life@x.com' }))!;
      const adm = (await makeUser(harness.db, { projectId: 1, email: 'adm-life@x.com', role: 'admin' }))!;
      A = session(a.id, a.email);
      B = session(b.id, b.email);
      Admin = session(adm.id, adm.email, 'admin');
      await harness.db.insert(userGroupMembership).values([
        { userId: A.id, categoryId: Payroll },
        { userId: B.id, categoryId: Payroll },
      ]);
      ready = true;
    } catch (e) {
      console.warn('[IT-STATE] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  let seq = 0;
  async function makeTicket(status: string, assigneeId: string | null): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#L${String(seq).padStart(5, '0')}`,
        subject: 'lifecycle',
        requesterEmail: 'r@x.com',
        mailbox: 'hris@test.local',
        categoryId: Payroll,
        status: status as 'open',
        assigneeId,
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  it('IT-STATE-001: illegal jump → 409, valid jump ok, non-assignee Member → 403', async () => {
    if (!ready) return;
    // AC2 — Open → Resolved is a forbidden skip.
    const t1 = await makeTicket('open', null);
    await expect(statusSvc.changeStatus(Admin, t1, { to: 'resolved' })).rejects.toMatchObject({
      status: 409,
    });
    const [r1] = await harness!.db.select().from(tickets).where(eq(tickets.id, t1));
    expect(r1!.status).toBe('open'); // untouched, no junk audit

    // Valid: Assigned → In Progress by the assignee.
    const t2 = await makeTicket('assigned', A.id);
    await statusSvc.changeStatus(A, t2, { to: 'in_progress' });
    const [r2] = await harness!.db.select().from(tickets).where(eq(tickets.id, t2));
    expect(r2!.status).toBe('in_progress');

    // AC4 — a Member who is not the assignee cannot drive someone else's ticket.
    const t3 = await makeTicket('in_progress', A.id);
    await expect(statusSvc.changeStatus(B, t3, { to: 'resolved' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('IT-CLOSE-001: Reply & Close writes message + outbox + Closed in one tx', async () => {
    if (!ready) return;
    const t = await makeTicket('in_progress', A.id);
    const res = await replySvc.reply(A, t, {
      to: ['r@x.com'],
      body: 'Done, closing.',
      closeAfter: true,
      confirmNewRecipients: true,
    });
    expect('closed' in res && res.closed).toBe(true);

    const [tk] = await harness!.db.select().from(tickets).where(eq(tickets.id, t));
    expect(tk!.status).toBe('closed');
    expect(tk!.closedAt).not.toBeNull();

    const out = await harness!.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, t), eq(ticketMessages.direction, 'outbound')));
    expect(out.length).toBe(1);
    const ob = await harness!.db.select().from(outbox).where(eq(outbox.ticketId, t));
    expect(ob.length).toBe(1); // the mail is guaranteed to go even though we're closed
  });

  it('IT-CLOSE-001b: an illegal close sends nothing (no half-done state)', async () => {
    if (!ready) return;
    const t = await makeTicket('open', A.id); // Open → Closed needs a junk/dup reason
    await expect(
      replySvc.reply(A, t, { to: ['r@x.com'], body: 'x', closeAfter: true }),
    ).rejects.toMatchObject({ status: 409 });
    const msgs = await harness!.db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t));
    const ob = await harness!.db.select().from(outbox).where(eq(outbox.ticketId, t));
    const [tk] = await harness!.db.select().from(tickets).where(eq(tickets.id, t));
    expect(msgs.length).toBe(0); // no reply leaked out
    expect(ob.length).toBe(0);
    expect(tk!.status).toBe('open'); // untouched
  });

  it('IT-CLOSE-002: reply permission matrix — assignee/member-in-group ok, Admin cannot reply but oversees the close via lifecycle', async () => {
    if (!ready) return;
    const t = await makeTicket('in_progress', A.id);
    // Story 12.3 (2026-07-22): a Member in the ticket's category group may reply even
    // when they are NOT the assignee (no claim required). Permission passes — the reply
    // only stops at the new-recipient guard (needsConfirm), so the ticket state is left
    // untouched for the Admin assertions below.
    await expect(
      replySvc.reply(B, t, { to: ['r@x.com'], body: 'x', closeAfter: true }),
    ).resolves.toMatchObject({ needsConfirm: true });

    // Admin is administrative — they do NOT process tickets by replying (sending email),
    // even to close. Reply & Close is rejected for Admin/SSA.
    await expect(
      replySvc.reply(Admin, t, {
        to: ['r@x.com'],
        body: 'closing for you',
        closeAfter: true,
        confirmNewRecipients: true,
      }),
    ).rejects.toMatchObject({ status: 403 });

    // …but Admin keeps lifecycle oversight: they can close via the status path (no email,
    // no processing) — the ticket isn't left stuck just because Admin can't reply.
    await statusSvc.changeStatus(Admin, t, { to: 'closed' });
    const [tk] = await harness!.db.select().from(tickets).where(eq(tickets.id, t));
    expect(tk!.status).toBe('closed');
  });

  it('IT-CLOSE-003: replying to a Pending ticket wakes it to In Progress and clears the snooze', async () => {
    if (!ready) return;
    const t = await makeTicket('pending', A.id);
    await harness!.db.update(tickets).set({ snoozeUntil: '2999-01-01' }).where(eq(tickets.id, t));
    const res = await replySvc.reply(A, t, {
      to: ['r@x.com'],
      body: 'following up',
      confirmNewRecipients: true,
    });
    expect('closed' in res && res.closed).toBe(false);
    const [tk] = await harness!.db.select().from(tickets).where(eq(tickets.id, t));
    expect(tk!.status).toBe('in_progress'); // woken, not left snoozed
    expect(tk!.snoozeUntil).toBeNull();
  });

  it('IT-CLOSE-004: reply & close on a Pending ticket closes it in one tx', async () => {
    if (!ready) return;
    const t = await makeTicket('pending', A.id);
    await harness!.db.update(tickets).set({ snoozeUntil: '2999-01-01' }).where(eq(tickets.id, t));
    const res = await replySvc.reply(A, t, {
      to: ['r@x.com'],
      body: 'resolved, closing',
      closeAfter: true,
      confirmNewRecipients: true,
    });
    expect('closed' in res && res.closed).toBe(true);
    const [tk] = await harness!.db.select().from(tickets).where(eq(tickets.id, t));
    expect(tk!.status).toBe('closed');
    expect(tk!.closedAt).not.toBeNull();
  });
});
