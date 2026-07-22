import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { categories, tickets } from '../src/infra/db/schema';
import { TicketsReadService } from '../src/modules/tickets/tickets-read.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const REQ = 'history-sender@x.com';
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
 * IT-HIST-001 — Story 12.5. requesterHistory now reports `prior`: how many tickets this
 * sender opened BEFORE the anchor ticket (created_at strictly earlier). `total` is
 * unchanged (all-time). Needs Docker.
 */
describe('IT-HIST: requester history prior count', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const read = new TicketsReadService();
  let ADMIN: SessionUser;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const a = (await makeUser(harness.db, { projectId: 1, email: 'adm-hist@x.com', role: 'admin' }))!;
      ADMIN = session(a.id, a.email, 'admin', 1);
      ready = true;
    } catch (e) {
      console.warn('[IT-HIST] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  let seq = 0;
  async function mk(daysAgo: number): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#H${String(seq).padStart(5, '0')}`,
        subject: 'hist',
        requesterEmail: REQ,
        mailbox: 'hris@test.local',
        status: 'open',
        createdAt: new Date(Date.now() - daysAgo * DAY),
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  it('IT-HIST-001: prior counts only tickets created before the anchor; total is all-time', async () => {
    if (!ready) return;
    await mk(5); // older
    await mk(4); // older
    const anchor = await mk(3); // ← anchor
    await mk(2); // newer
    await mk(1); // newer

    const h = await read.requesterHistory(ADMIN, anchor);
    expect(h.total).toBe(5); // all tickets by this sender
    expect(h.prior).toBe(2); // only the two created before the anchor
  });

  it('IT-HIST-002: history is anchored by ticket id under RLS — out-of-group member is refused (no leak)', async () => {
    if (!ready) return;
    // Payroll category (a real group, never the open pool) → invisible to a member with
    // no membership in it. The email is NEVER accepted from the client, only the ticket id.
    const [payroll] = await harness!.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.nameEn, 'Payroll'));
    const [anchor] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: '#HOUT1',
        subject: 'hist-out',
        requesterEmail: 'stranger@ext.com',
        mailbox: 'hris@test.local',
        status: 'open',
        categoryId: payroll!.id,
      })
      .returning({ id: tickets.id });

    const member = (await makeUser(harness!.db, { projectId: 1, role: 'member', email: 'hist-out@x.com' }))!;
    const memberSession = session(member.id, member.email, 'member', 1);
    // RLS hides the ticket → requesterHistory throws NotFound rather than leaking counts.
    await expect(read.requesterHistory(memberSession, anchor!.id)).rejects.toThrow();
  });
});
