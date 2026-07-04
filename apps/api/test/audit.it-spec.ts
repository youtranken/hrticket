import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { writeAudit } from '../src/infra/audit/audit';
import { categories, tickets, userGroupMembership, viewLog, attachments, ticketMessages } from '../src/infra/db/schema';
import { AuditService } from '../src/modules/audit/audit.service';
import type { SessionUser } from '../src/modules/auth/session.service';

/**
 * IT-AUDIT-001/002/003 — Story 9.5 (FR66–FR72). The audit + view-log READER:
 *  001 one ticket's full lifecycle (filter by ticket → ordered chain);
 *  002 the 3-role read scope (Admin=project incl config, TL=own-group ticket-logs only,
 *      Member=403) + append-only (REVOKE UPDATE/DELETE bites the app role) + cross-year
 *      partition query;
 *  003 the sensitive view-log answers "who viewed / downloaded".
 * Needs Docker.
 */
describe('IT-AUDIT: audit + view-log reader', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new AuditService();
  const HRIS = 1;
  let Payroll = 0;
  let Leave = 0;
  const PAGE = { page: 1, pageSize: 100 };

  const session = (id: string, role: SessionUser['role']): SessionUser => ({
    id,
    email: `${id}@x.com`,
    name: id,
    role,
    projectId: HRIS,
    disabled: false,
    mustChangePassword: false,
  });

  async function audit(action: string, objectType: string, objectId: string, oldV: unknown, newV: unknown) {
    await withActor(systemActor, (tx) =>
      writeAudit(tx, {
        projectId: HRIS,
        actorId: null,
        actorLabel: 'system',
        action,
        objectType,
        objectId,
        oldValue: oldV,
        newValue: newV,
      }),
    );
  }

  let seq = 0;
  async function makeTicket(categoryId: number): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: HRIS,
        ticketCode: `#A${String(seq).padStart(5, '0')}`,
        subject: 'audit me',
        requesterEmail: 'req@x.com',
        mailbox: 'hris@test.local',
        categoryId,
        status: 'open',
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
      console.warn('[IT-AUDIT] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(viewLog);
      await harness!.db.delete(attachments);
      await harness!.db.delete(ticketMessages);
      await harness!.db.delete(tickets);
      await harness!.db.execute(sql`DELETE FROM audit_log`);
    }
  });

  it('IT-AUDIT-001: a ticket lifecycle reads back as an ordered chain (AC1)', async () => {
    if (!ready) return;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'au1-adm@x.com' }))!;
    const T = await makeTicket(Payroll);
    for (const a of ['ticket.created', 'ticket.assigned', 'ticket.reopened', 'ticket.closed']) {
      await audit(a, 'ticket', T, null, { step: a });
    }
    // Some noise for ANOTHER ticket that must not leak into this filter.
    const other = await makeTicket(Payroll);
    await audit('ticket.created', 'ticket', other, null, {});

    const res = await svc.list(session(admin.id, 'admin'), HRIS, { ...PAGE, ticketId: T });
    expect(res.total).toBe(4);
    expect(res.items.every((i) => i.objectId === T)).toBe(true);
    // Newest first (created_at desc, id desc tiebreak) → last action on top.
    expect(res.items.map((i) => i.action)).toEqual([
      'ticket.closed',
      'ticket.reopened',
      'ticket.assigned',
      'ticket.created',
    ]);
  });

  it('IT-AUDIT-002: 3-role scope + append-only + cross-year partition (AC2/AC4)', async () => {
    if (!ready) return;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'au2-adm@x.com' }))!;
    const tl = (await makeUser(harness!.db, { projectId: HRIS, role: 'team_lead', email: 'au2-tl@x.com' }))!;
    const member = (await makeUser(harness!.db, { projectId: HRIS, role: 'member', email: 'au2-m@x.com' }))!;
    await harness!.db.insert(userGroupMembership).values({ userId: tl.id, categoryId: Payroll });

    const payT = await makeTicket(Payroll);
    const leaveT = await makeTicket(Leave);
    await audit('ticket.created', 'ticket', payT, null, {}); // Payroll ticket log
    await audit('ticket.created', 'ticket', leaveT, null, {}); // Leave ticket log
    await audit('category.updated', 'category', String(Payroll), { a: 1 }, { a: 2 }); // CONFIG log

    // Admin sees everything in the project (incl. the config log).
    const adminRes = await svc.list(session(admin.id, 'admin'), HRIS, PAGE);
    expect(adminRes.items.some((i) => i.objectType === 'category')).toBe(true);
    expect(adminRes.items.filter((i) => i.objectType === 'ticket').length).toBe(2);

    // Team Lead (Payroll) sees ONLY Payroll ticket-logs — no config, no Leave.
    const tlRes = await svc.list(session(tl.id, 'team_lead'), HRIS, PAGE);
    expect(tlRes.items.every((i) => i.objectType === 'ticket' && i.objectId === payT)).toBe(true);
    expect(tlRes.items.some((i) => i.objectType === 'category')).toBe(false);
    expect(tlRes.total).toBe(1);

    // Member → 403.
    await expect(svc.list(session(member.id, 'member'), HRIS, PAGE)).rejects.toMatchObject({ status: 403 });

    // AC4 — append-only: the app role may not UPDATE or DELETE audit_log (REVOKE).
    await expect(
      withActor(systemActor, (tx) => tx.execute(sql`UPDATE audit_log SET action = 'tampered'`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withActor(systemActor, (tx) => tx.execute(sql`DELETE FROM audit_log`)),
    ).rejects.toThrow(/permission denied/i);

    // AC4 — cross-year partition: a 2027 row is still found alongside 2026 rows.
    await harness!.db.execute(sql`
      INSERT INTO audit_log (project_id, actor_label, action, object_type, object_id, created_at)
      VALUES (${HRIS}, 'system', 'ticket.closed', 'ticket', ${payT}, '2027-02-01T00:00:00Z')
    `);
    const cross = await svc.list(session(admin.id, 'admin'), HRIS, { ...PAGE, ticketId: payT });
    expect(cross.items.map((i) => i.action).sort()).toEqual(['ticket.closed', 'ticket.created']);
  });

  it('IT-AUDIT-003: sensitive view-log answers "who viewed / downloaded" (AC3)', async () => {
    if (!ready) return;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'au3-adm@x.com' }))!;
    const tlLeave = (await makeUser(harness!.db, { projectId: HRIS, role: 'team_lead', email: 'au3-tl-leave@x.com' }))!;
    await harness!.db.insert(userGroupMembership).values({ userId: tlLeave.id, categoryId: Leave });
    const v1 = (await makeUser(harness!.db, { projectId: HRIS, email: 'au3-v1@x.com' }))!;
    const v2 = (await makeUser(harness!.db, { projectId: HRIS, email: 'au3-v2@x.com' }))!;
    const v3 = (await makeUser(harness!.db, { projectId: HRIS, email: 'au3-v3@x.com' }))!;

    const T = await makeTicket(Payroll);
    const [att] = await harness!.db
      .insert(attachments)
      .values({ ticketId: T, fileName: 'payslip.pdf', mimeType: 'application/pdf', size: 5, storagePath: 'a/b', status: 'stored' })
      .returning({ id: attachments.id });
    await harness!.db.insert(viewLog).values([
      { actorId: v1.id, ticketId: T, action: 'ticket_view' },
      { actorId: v2.id, ticketId: T, action: 'ticket_view' },
      { actorId: v3.id, ticketId: T, action: 'ticket_view' },
      { actorId: v1.id, ticketId: T, attachmentId: att!.id, action: 'file_download' },
    ]);

    const res = await svc.viewLogList(session(admin.id, 'admin'), HRIS, { ...PAGE, ticketId: T });
    expect(res.total).toBe(4);
    const actions = (res.items as Array<{ action: string }>).map((i) => i.action).sort();
    expect(actions).toEqual(['file_download', 'ticket_view', 'ticket_view', 'ticket_view']);
    const dl = (res.items as Array<{ action: string; fileName: string | null; actorName: string }>).find(
      (i) => i.action === 'file_download',
    )!;
    expect(dl.fileName).toBe('payslip.pdf');

    // A Leave team-lead can't see the Payroll ticket's view-log (scope).
    const leaveRes = await svc.viewLogList(session(tlLeave.id, 'team_lead'), HRIS, { ...PAGE, ticketId: T });
    expect(leaveRes.total).toBe(0);
  });

  it('IT-AUDIT-004: action list + CSV export ride the reader scope (#55)', async () => {
    if (!ready) return;
    const admin = (await makeUser(harness!.db, { projectId: HRIS, role: 'admin', email: 'au4-adm@x.com' }))!;
    const member = (await makeUser(harness!.db, { projectId: HRIS, role: 'member', email: 'au4-m@x.com' }))!;
    const T = await makeTicket(Payroll);
    await audit('ticket.created', 'ticket', T, null, {});
    await audit('ticket.assigned', 'ticket', T, null, { to: 'x' });

    // Distinct actions feed the FE Select; a member is refused outright.
    const actions = await svc.listActions(session(admin.id, 'admin'), HRIS);
    expect(actions).toEqual(expect.arrayContaining(['ticket.created', 'ticket.assigned']));
    await expect(svc.listActions(session(member.id, 'member'), HRIS)).rejects.toMatchObject({
      status: 403,
    });

    // The export table mirrors the on-screen list (same filter, same scope) and
    // serializes to CSV with the localized header.
    const { ExportService } = await import('../src/modules/export/export.service');
    const { TicketsReadService } = await import('../src/modules/tickets/tickets-read.service');
    const { ReportingService } = await import('../src/modules/reporting/reporting.service');
    const exportSvc = new ExportService(new TicketsReadService(), new ReportingService(), svc);
    const table = await exportSvc.auditTable(
      session(admin.id, 'admin'),
      HRIS,
      { action: 'ticket.created' },
      'vi',
    );
    expect(table.rowCount).toBe(1);
    expect(table.headers[0]).toBe('Thời điểm');
    const csv = exportSvc.toCsv(table).toString('utf8');
    expect(csv).toContain('ticket.created');
    // A member can't export what they can't read.
    await expect(
      exportSvc.auditTable(session(member.id, 'member'), HRIS, {}, 'vi'),
    ).rejects.toMatchObject({ status: 403 });
  });
});
