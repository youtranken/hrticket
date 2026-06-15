import { eq, count } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor } from '../src/infra/db/with-actor';
import { actorForUser } from '../src/modules/tickets/actor';
import {
  categories,
  tickets,
  ticketMessages,
  attachments,
  userGroupMembership,
  viewLog,
} from '../src/infra/db/schema';
import { TicketsReadService } from '../src/modules/tickets/tickets-read.service';
import { TicketSearchService } from '../src/modules/tickets/ticket-search.service';
import { SessionService } from '../src/modules/auth/session.service';
import { ticketListQuerySchema } from '../src/modules/tickets/dto/ticket-list.query';
import type { SessionUser } from '../src/modules/auth/session.service';

/**
 * IT-VIS-001/002 — Story 9.3 (FR59/FR60/FR65). The hardest RLS scenario.
 *  001: keep-work-in-progress is BOUNDED — an assignee keeps a ticket through a group
 *       removal / re-categorisation, but loses it the moment it is closed or reassigned.
 *  002: the endpoint SWEEP. A sensitive ticket (subject + body + internal note +
 *       attachment) must be invisible across EVERY ticket-data read path to 5 actor
 *       profiles (out-of-group, other-project, none-granted, disabled, anonymous).
 *       A leak = build red. New read endpoints MUST be added to READERS below.
 * Needs Docker.
 */
describe('IT-VIS: advanced visibility', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const read = new TicketsReadService();
  const searchSvc = new TicketSearchService();
  const sessions = new SessionService();
  const HRIS = 1;
  const CNB = 2;
  let Payroll = 0; // sensitive
  let Leave = 0;
  const Q = ticketListQuerySchema.parse({});

  const session = (id: string, projectId: number | null = HRIS, role: SessionUser['role'] = 'member'): SessionUser => ({
    id,
    email: `${id}@x.com`,
    name: id,
    role,
    projectId,
    disabled: false,
    mustChangePassword: false,
  });

  let seq = 0;
  async function makeTicket(
    categoryId: number,
    assigneeId: string | null,
    status: 'open' | 'in_progress' | 'closed' = 'open',
    subject = 'vis ticket',
  ): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: HRIS,
        ticketCode: `#V${String(seq).padStart(5, '0')}`,
        subject,
        requesterEmail: 'req@x.com',
        mailbox: 'hris@test.local',
        categoryId,
        status,
        assigneeId,
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  /** Tickets the actor can SELECT under RLS (role app + live groups). */
  async function rlsCount(u: SessionUser, ticketId: string): Promise<number> {
    const ctx = await actorForUser(u);
    return withActor(ctx, async (tx) => {
      const [r] = await tx.select({ n: count() }).from(tickets).where(eq(tickets.id, ticketId));
      return Number(r!.n);
    });
  }

  /** File access path replica (FilesService.mintAccessUrl): attachments JOIN tickets. */
  async function fileVisible(u: SessionUser, attId: string): Promise<boolean> {
    const ctx = await actorForUser(u);
    return withActor(ctx, async (tx) => {
      const rows = await tx
        .select({ id: attachments.id })
        .from(attachments)
        .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
        .where(eq(attachments.id, attId));
      return rows.length > 0;
    });
  }

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id; // isSensitive = true (seed)
      Leave = cats.find((c) => c.nameEn === 'Leave')!.id;
      ready = true;
    } catch (e) {
      console.warn('[IT-VIS] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(viewLog); // FK → tickets (written by getDetail on sensitive)
      await harness!.db.delete(attachments);
      await harness!.db.delete(ticketMessages);
      await harness!.db.delete(tickets);
      await harness!.db.delete(userGroupMembership);
    }
  });

  it('IT-VIS-001: keep-work-in-progress is bounded (survives group change, dies on close/reassign)', async () => {
    if (!ready) return;
    const m = (await makeUser(harness!.db, { projectId: HRIS, email: 'vis-m@x.com' }))!;
    const other = (await makeUser(harness!.db, { projectId: HRIS, email: 'vis-o@x.com' }))!;
    await harness!.db.insert(userGroupMembership).values([
      { userId: m.id, categoryId: Payroll },
      { userId: other.id, categoryId: Payroll },
    ]);
    const mine = await makeTicket(Payroll, m.id, 'in_progress'); // #5
    const theirs1 = await makeTicket(Payroll, other.id, 'in_progress'); // #6
    const theirs2 = await makeTicket(Payroll, other.id, 'open'); // #7
    const S = (u: typeof m) => session(u.id);

    // In-group: M sees all three.
    expect(await rlsCount(S(m), mine)).toBe(1);
    expect(await rlsCount(S(m), theirs1)).toBe(1);

    // Remove M from Payroll → AC2: #6/#7 vanish at once; #5 stays (carve-out, in_progress).
    await harness!.db.delete(userGroupMembership).where(eq(userGroupMembership.userId, m.id));
    expect(await rlsCount(S(m), theirs1)).toBe(0);
    expect(await rlsCount(S(m), theirs2)).toBe(0);
    expect(await rlsCount(S(m), mine)).toBe(1);
    await expect(read.getDetail(S(m), theirs1)).rejects.toMatchObject({ status: 404 });
    expect((await read.getDetail(S(m), mine)).ticket.id).toBe(mine);

    // AC1(b): re-categorise #5 OUT of M's groups → still visible (carve-out is assignee-based).
    await harness!.db.update(tickets).set({ categoryId: Leave }).where(eq(tickets.id, mine));
    expect(await rlsCount(S(m), mine)).toBe(1);

    // Close #5 → carve-out expires → M loses it (AC1).
    await harness!.db.update(tickets).set({ status: 'closed' }).where(eq(tickets.id, mine));
    expect(await rlsCount(S(m), mine)).toBe(0);
    await expect(read.getDetail(S(m), mine)).rejects.toMatchObject({ status: 404 });

    // Reassign branch: reopen but hand to someone else → still invisible to M.
    await harness!.db.update(tickets).set({ status: 'in_progress', assigneeId: other.id }).where(eq(tickets.id, mine));
    expect(await rlsCount(S(m), mine)).toBe(0);
  });

  it('IT-VIS-002: endpoint sweep — sensitive ticket invisible to all 5 actor profiles', async () => {
    if (!ready) return;
    const inGroup = (await makeUser(harness!.db, { projectId: HRIS, email: 'sw-in@x.com' }))!;
    const outGroup = (await makeUser(harness!.db, { projectId: HRIS, email: 'sw-out@x.com' }))!;
    const foreign = (await makeUser(harness!.db, { projectId: CNB, email: 'sw-cnb@x.com' }))!;
    const none = (await makeUser(harness!.db, { projectId: HRIS, email: 'sw-none@x.com' }))!;
    const disabled = (await makeUser(harness!.db, { projectId: HRIS, email: 'sw-dis@x.com', disabled: true }))!;
    await harness!.db.insert(userGroupMembership).values([
      { userId: inGroup.id, categoryId: Payroll },
      { userId: outGroup.id, categoryId: Leave },
      // `disabled` is even a Payroll member — proving the block is the SESSION layer, not RLS.
      { userId: disabled.id, categoryId: Payroll },
    ]);

    const TOKEN = 'zzqsecret'; // distinctive FTS token in the subject
    const X = await makeTicket(Payroll, null, 'open', `luong mat ${TOKEN}`);
    const [msg] = await harness!.db
      .insert(ticketMessages)
      .values({ ticketId: X, direction: 'inbound', fromAddr: 'req@x.com', bodyText: 'salary body secret' })
      .returning({ id: ticketMessages.id });
    await harness!.db
      .insert(ticketMessages)
      .values({ ticketId: X, direction: 'outbound', isInternal: true, fromAddr: 'agent@x.com', bodyText: 'internal note secret' });
    const [att] = await harness!.db
      .insert(attachments)
      .values({
        ticketId: X,
        messageId: msg!.id,
        fileName: 'payslip.pdf',
        mimeType: 'application/pdf',
        size: 10,
        storagePath: 'x/y',
        status: 'stored',
      })
      .returning({ id: attachments.id });

    // Control: the in-group member CAN reach it through every path.
    expect((await read.getDetail(session(inGroup.id), X)).ticket.id).toBe(X);
    expect((await read.list(session(inGroup.id), Q)).items.some((i) => i.id === X)).toBe(true);
    expect((await searchSvc.search(session(inGroup.id), TOKEN)).items.some((i) => i.id === X)).toBe(true);
    expect(await fileVisible(session(inGroup.id), att!.id)).toBe(true);

    // RLS-boundary profiles: every read path must come back empty/404.
    const blocked: Array<[string, SessionUser]> = [
      ['out-of-group', session(outGroup.id)],
      ['other-project', session(foreign.id, CNB)],
      ['none-granted', session(none.id)],
    ];
    for (const [label, actor] of blocked) {
      console.log(`[IT-VIS-002] sweeping profile: ${label}`);
      await expect(read.getDetail(actor, X)).rejects.toMatchObject({ status: 404 });
      expect((await read.list(actor, Q)).items.some((i) => i.id === X)).toBe(false);
      const exportRows = await read.listForExport(actor, Q, 1000);
      expect(exportRows.length).toBe(0);
      expect((await searchSvc.search(actor, TOKEN)).items.some((i) => i.id === X)).toBe(false);
      expect((await searchSvc.search(actor, 'secret')).items.some((i) => i.id === X)).toBe(false);
      expect(await rlsCount(actor, X)).toBe(0);
      expect(await fileVisible(actor, att!.id)).toBe(false);
    }

    // disabled profile: blocked at the SESSION layer even though RLS would grant (Payroll member).
    expect(await rlsCount(session(disabled.id), X)).toBe(1); // RLS alone would leak…
    const sid = await sessions.create(disabled.id);
    expect(await sessions.resolve(sid)).toBeNull(); // …but the session is rejected (FR63/FR65)

    // anonymous profile: no valid session resolves.
    expect(await sessions.resolve('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
