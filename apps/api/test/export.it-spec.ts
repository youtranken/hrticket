import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { tickets, categories, userGroupMembership } from '../src/infra/db/schema';
import { TicketsReadService } from '../src/modules/tickets/tickets-read.service';
import { ReportingService } from '../src/modules/reporting/reporting.service';
import { ExportService, ExportTooLargeError } from '../src/modules/export/export.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { exportTicketsSchema, asTicketListQuery } from '../src/modules/export/dto/export.body';
import { ticketListQuerySchema } from '../src/modules/tickets/dto/ticket-list.query';
import type { SessionUser } from '../src/modules/auth/session.service';

const HRIS = 1;

function asSession(row: {
  id: string;
  email: string;
  name: string;
  role: string;
  projectId: number | null;
}): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as SessionUser['role'],
    projectId: row.projectId,
    disabled: false,
    mustChangePassword: false,
  };
}

const Q = (over = {}) => ticketListQuerySchema.parse({ pageSize: 100, ...over });

/**
 * IT-EXPORT-001..002 — Story 10.4 (FR84). xlsx/csv export with VN dates + UTF-8
 * BOM, parsed back to assert content; visibility (RLS) carries into the file; the
 * 10k cap is a hard 422 (no partial); each export writes an audit row. Self-skips
 * without Docker.
 */
describe('IT-EXPORT: Excel / CSV export', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new ExportService(new TicketsReadService(), new ReportingService(), new AuditService());

  let Payroll: number;
  let Insurance: number;
  let adminU: SessionUser;
  let tlPayrollU: SessionUser;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, en: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      Payroll = cats.find((c) => c.en === 'Payroll')!.id;
      Insurance = cats.find((c) => c.en !== 'Payroll' && c.en !== 'Other')?.id ?? cats.find((c) => c.en !== 'Payroll')!.id;

      const admin = (await makeUser(harness.db, { projectId: HRIS, email: 'adm-exp@t.local', role: 'admin' }))!;
      const tl = (await makeUser(harness.db, { projectId: HRIS, email: 'tl-exp@t.local', role: 'team_lead' }))!;
      adminU = asSession(admin);
      tlPayrollU = asSession(tl);
      await harness.db.insert(userGroupMembership).values({ userId: tl.id, categoryId: Payroll });

      ready = true;
    } catch (e) {
      console.warn('[IT-EXPORT] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(tickets);
  });

  let seq = 0;
  async function mk(opts: { subject: string; categoryId?: number; isJunk?: boolean; createdAt?: Date }) {
    seq += 1;
    await harness!.db.insert(tickets).values({
      projectId: HRIS,
      ticketCode: `#X${String(seq).padStart(5, '0')}`,
      subject: opts.subject,
      requesterEmail: 'r@x.com',
      mailbox: 'hris@test.local',
      categoryId: opts.categoryId ?? Payroll,
      status: 'open',
      isJunk: opts.isJunk ?? false,
      createdAt: opts.createdAt ?? new Date('2026-05-15T03:00:00Z'),
    });
  }

  it('IT-EXPORT-001: xlsx + csv content, VN date, UTF-8 BOM', async () => {
    if (!ready) return;
    await mk({ subject: 'Lương tháng 5', createdAt: new Date('2026-05-15T03:00:00Z') }); // 10:00 VN

    const table = await svc.ticketsTable(adminU, Q(), 'vi');
    expect(table.rowCount).toBe(1);
    // VN date 'dd/MM/yyyy HH:mm' — 03:00 UTC = 10:00 VN on 15/05/2026.
    const createdCell = table.rows[0]![7];
    expect(createdCell).toBe('15/05/2026 10:00');

    // DTO regression: the export body validates the TYPED JSON the FE sends
    // (number arrays), NOT raw query strings — a number[] categoryId must parse
    // and flow straight into a filtered export (caught only at the body layer).
    const parsed = exportTicketsSchema.parse({ format: 'csv', lang: 'vi', filter: { categoryId: [Payroll], pageSize: 100 } });
    const typedTable = await svc.ticketsTable(adminU, asTicketListQuery(parsed.filter), 'vi');
    expect(typedTable.rowCount).toBe(1);

    // xlsx — parse the bytes back.
    const xlsx = await svc.toXlsx(table);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).getCell(1).value).toBe('Mã'); // bold header (vi)
    expect(ws.getRow(2).getCell(2).value).toBe('Lương tháng 5'); // subject row, diacritics intact

    // csv — leading UTF-8 BOM + the Vietnamese subject preserved.
    const csv = svc.toCsv(table);
    expect(csv[0]).toBe(0xef);
    expect(csv[1]).toBe(0xbb);
    expect(csv[2]).toBe(0xbf);
    expect(csv.toString('utf8')).toContain('Lương tháng 5');
  });

  it('IT-EXPORT-002: RLS in export + >10k cap 422 + audit row', async () => {
    if (!ready) return;
    // AC2 — TL(Payroll) export "all": only Payroll rows, never Insurance.
    await mk({ subject: 'payroll a', categoryId: Payroll });
    await mk({ subject: 'insurance b', categoryId: Insurance });
    const tlTable = await svc.ticketsTable(tlPayrollU, Q(), 'en');
    expect(tlTable.rowCount).toBe(1);
    expect(tlTable.rows[0]![1]).toBe('payroll a');

    // AC3 — audit row written for the export.
    const audit = await harness!.sql`SELECT action, new_value FROM audit_log WHERE action = 'export.tickets' ORDER BY id DESC LIMIT 1`;
    expect(audit.length).toBe(1);
    expect((audit[0] as { new_value: { rowCount: number } }).new_value.rowCount).toBe(1);

    // AC3 — over the cap → hard error, no partial file. Bulk-seed >10k Payroll.
    await harness!.db.delete(tickets);
    const rows = Array.from({ length: 10_001 }, (_, i) => ({
      projectId: HRIS,
      ticketCode: `#C${String(i).padStart(6, '0')}`,
      subject: 'bulk',
      requesterEmail: 'b@x.com',
      mailbox: 'hris@test.local',
      categoryId: Payroll,
      status: 'open' as const,
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      await harness!.db.insert(tickets).values(rows.slice(i, i + 1000));
    }
    await expect(svc.ticketsTable(adminU, Q(), 'vi')).rejects.toBeInstanceOf(ExportTooLargeError);
  });
});
