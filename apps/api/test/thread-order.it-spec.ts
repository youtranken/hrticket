import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { tickets, ticketMessages, ticketLink } from '../src/infra/db/schema';
import { TicketsReadService } from '../src/modules/tickets/tickets-read.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const DAY = 86_400_000;
const session = (id: string, email: string, role: SessionUser['role'], projectId: number | null): SessionUser => ({
  id,
  email,
  name: email,
  role,
  projectId,
  disabled: false,
  mustChangePassword: false,
});

/**
 * IT-THREAD-001/002 — Story 12.1. The thread is ordered by RECEIVED time (when our
 * system ingested the message), not the Date header — so a CC reply that arrives after
 * another message sinks below it even if its own Date is older. Falls back to created_at
 * when received_at is NULL (pre-12.1 rows). Needs Docker.
 */
describe('IT-THREAD: mail thread ordered by received time', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const read = new TicketsReadService();
  let ADMIN: SessionUser;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const a = (await makeUser(harness.db, { projectId: 1, email: 'adm-thr@x.com', role: 'admin' }))!;
      ADMIN = session(a.id, a.email, 'admin', 1);
      ready = true;
    } catch (e) {
      console.warn('[IT-THREAD] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  async function mkTicket(projectId = 1): Promise<string> {
    const [tk] = await harness!.db
      .insert(tickets)
      .values({
        projectId,
        ticketCode: `#T${projectId}${Math.floor(Number(process.hrtime.bigint() % 100000n))}`,
        subject: 'thread',
        requesterEmail: 'req@ext.com',
        mailbox: 'hris@test.local',
        status: 'in_progress',
        assigneeId: projectId === 1 ? ADMIN.id : null,
      })
      .returning({ id: tickets.id });
    return tk!.id;
  }

  async function addMsg(
    ticketId: string,
    label: string,
    createdAt: Date,
    receivedAt: Date | null,
  ): Promise<string> {
    const [m] = await harness!.db
      .insert(ticketMessages)
      .values({
        ticketId,
        direction: 'inbound',
        fromAddr: `${label}@ext.com`,
        bodyText: label,
        createdAt,
        receivedAt,
      })
      .returning({ id: ticketMessages.id });
    return m!.id;
  }

  it('IT-THREAD-001: a late-arriving CC reply (older Date) sinks to the bottom', async () => {
    if (!ready) return;
    const tid = await mkTicket();
    // M1 sent & received 2 days ago; M2 sent & received 1 day ago.
    const m1 = await addMsg(tid, 'm1', new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
    const m2 = await addMsg(tid, 'm2', new Date(Date.now() - 1 * DAY), new Date(Date.now() - 1 * DAY));
    // CC reply: Date header is OLD (1.5 days ago, between M1 and M2) but it ARRIVED now.
    const cc = await addMsg(tid, 'cc', new Date(Date.now() - 1.5 * DAY), new Date());

    const detail = await read.getDetail(ADMIN, tid);
    const order = detail.messages.map((x) => x.id);
    expect(order).toEqual([m1, m2, cc]); // cc last (arrived last), not middle by Date
  });

  it('IT-THREAD-002: received_at NULL falls back to created_at (pre-12.1 rows)', async () => {
    if (!ready) return;
    const tid = await mkTicket();
    const a = await addMsg(tid, 'a', new Date(Date.now() - 3 * DAY), null);
    const b = await addMsg(tid, 'b', new Date(Date.now() - 1 * DAY), null);
    const detail = await read.getDetail(ADMIN, tid);
    const order = detail.messages.map((x) => x.id);
    expect(order).toEqual([a, b]); // by created_at, unchanged behaviour
  });

  it('IT-THREAD-003: equal received_at → stable tie-break by created_at then id (2 reads)', async () => {
    if (!ready) return;
    const tid = await mkTicket();
    const rt = new Date(Date.now() - 1 * DAY);
    // Same received_at; created_at differs → order must fall to created_at asc, stably.
    const a = await addMsg(tid, 'a', new Date(Date.now() - 3 * DAY), rt);
    const b = await addMsg(tid, 'b', new Date(Date.now() - 2 * DAY), rt);
    const r1 = (await read.getDetail(ADMIN, tid)).messages.map((x) => x.id);
    const r2 = (await read.getDetail(ADMIN, tid)).messages.map((x) => x.id);
    expect(r1).toEqual([a, b]); // created_at asc tie-break
    expect(r2).toEqual(r1); // deterministic across reads (AC3)
  });

  it('IT-THREAD-004: cross-post merges both sides by received_at across projects', async () => {
    if (!ready) return;
    const main = await mkTicket(1);
    const sib = await mkTicket(2);
    await harness!.db.insert(ticketLink).values({ ticketA: main, ticketB: sib, kind: 'cross_post' });
    // Interleave by received time: main@-3d, sibling@-2d, main@-1d.
    const m1 = await addMsg(main, 'm1', new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
    const s1 = await addMsg(sib, 's1', new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
    const m2 = await addMsg(main, 'm2', new Date(Date.now() - 1 * DAY), new Date(Date.now() - 1 * DAY));
    const order = (await read.getDetail(ADMIN, main)).messages.map((x) => x.id);
    // Merged by received_at across projects, NOT grouped by project.
    expect(order).toEqual([m1, s1, m2]);
  });

  it('IT-THREAD-005: a future Date header (created_at) does not jump the message — received_at governs', async () => {
    if (!ready) return;
    const tid = await mkTicket();
    const m1 = await addMsg(tid, 'm1', new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
    // Spoofed FUTURE created_at (Date header) but ingested now → must stay ordered by
    // received_at, not leap around (Option A robustness — created_at never steers order).
    const m2 = await addMsg(tid, 'm2', new Date(Date.now() + 3 * DAY), new Date(Date.now() - 1 * DAY));
    const order = (await read.getDetail(ADMIN, tid)).messages.map((x) => x.id);
    expect(order).toEqual([m1, m2]);
  });
});
