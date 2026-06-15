import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { withActor } from '../../infra/db/with-actor';
import { writeAudit } from '../../infra/audit/audit';
import { actorForUser } from '../tickets/actor';
import { TicketsReadService, type TicketExportRow } from '../tickets/tickets-read.service';
import { ReportingService } from '../reporting/reporting.service';
import type { TicketListQuery } from '../tickets/dto/ticket-list.query';
import type { SessionUser } from '../auth/session.service';

export type ExportFormat = 'xlsx' | 'csv';
export const EXPORT_ROW_CAP = 10_000;

/** A simple tabular payload: a header row + string cells (already VN-formatted). */
export interface ExportTable {
  /** Localised column headers. */
  headers: string[];
  /** Row cells as strings (dates already 'dd/MM/yyyy HH:mm' VN). */
  rows: string[][];
  /** Suggested base filename (no extension), e.g. 'tickets_2026-06-15'. */
  baseName: string;
  sheetName: string;
  rowCount: number;
}

/** Thrown when the filtered set exceeds the cap — controller maps to 422 (AC3). */
export class ExportTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super('Export exceeds the row limit');
  }
}

/** Format a UTC instant as VN-local 'dd/MM/yyyy HH:mm' (FR84). */
function vnDateTime(d: Date | null): string {
  if (!d) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

function todayVn(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

@Injectable()
export class ExportService {
  constructor(
    private readonly ticketsRead: TicketsReadService,
    private readonly reporting: ReportingService,
  ) {}

  /** Build the ticket-export table (FR84). Reuses the 10.1 RLS+filter path; over
   *  the cap → ExportTooLargeError (no silent cut). Audits the export. */
  async ticketsTable(user: SessionUser, q: TicketListQuery, lang: 'vi' | 'en'): Promise<ExportTable> {
    const rows = await this.ticketsRead.listForExport(user, q, EXPORT_ROW_CAP);
    if (rows.length > EXPORT_ROW_CAP) throw new ExportTooLargeError(EXPORT_ROW_CAP);

    await this.audit(user, 'export.tickets', { filter: q, rowCount: rows.length });

    const L = labels(lang);
    const headers = [
      L.code, L.subject, L.category, L.status, L.requester, L.assignee,
      L.tags, L.createdAt, L.closedAt, L.overdue, L.reopenCount,
    ];
    const body = rows.map((r: TicketExportRow) => [
      r.ticketCode,
      r.subject,
      (lang === 'en' ? r.categoryEn : r.categoryVi) ?? '',
      r.status,
      r.requesterEmail,
      r.assigneeName ?? '',
      r.tags.join(', '),
      vnDateTime(r.createdAt),
      vnDateTime(r.closedAt),
      r.isOverdue ? String(r.overdueDays) : '',
      String(r.reopenCount),
    ]);
    return {
      headers,
      rows: body,
      baseName: `tickets_${todayVn()}`,
      sheetName: 'Tickets',
      rowCount: rows.length,
    };
  }

  /** Build a report-export table matching the 10.3 on-screen numbers (AC4). */
  async reportTable(
    user: SessionUser,
    projectId: number,
    kind: 'by-time' | 'by-category' | 'by-staff',
    range: { from?: string; to?: string },
    lang: 'vi' | 'en',
  ): Promise<ExportTable> {
    const L = labels(lang);
    let headers: string[];
    let rows: string[][];
    if (kind === 'by-time') {
      const { buckets } = await this.reporting.byTime(user, projectId, range.from, range.to);
      headers = [L.month, L.created, L.closed, L.open, L.overdue, L.reopened];
      rows = buckets.map((b) => [b.bucket, n(b.created), n(b.closed), n(b.open), n(b.overdue), n(b.reopened)]);
    } else if (kind === 'by-category') {
      const { categories } = await this.reporting.byCategory(user, projectId, range.from, range.to);
      headers = [L.category, L.created, L.closed, L.open, L.overdue];
      rows = categories.map((c) => [
        (lang === 'en' ? c.nameEn : c.nameVi) ?? L.uncategorized,
        n(c.created), n(c.closed), n(c.open), n(c.overdue),
      ]);
    } else {
      const { staff } = await this.reporting.byStaff(user, projectId, range.from, range.to);
      headers = [L.assignee, L.handled, L.closed, L.open, L.overdue];
      rows = staff.map((s) => [s.name ?? L.unassigned, n(s.handled), n(s.closed), n(s.open), n(s.overdue)]);
    }
    await this.audit(user, 'export.report', { kind, range, rowCount: rows.length });
    return { headers, rows, baseName: `report_${kind}_${todayVn()}`, sheetName: 'Report', rowCount: rows.length };
  }

  /** Serialize a table to an xlsx Buffer (bold header, auto-width). */
  async toXlsx(table: ExportTable): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(table.sheetName);
    ws.addRow(table.headers);
    ws.getRow(1).font = { bold: true };
    for (const r of table.rows) ws.addRow(r);
    // Auto-ish width: widest cell per column, capped.
    ws.columns.forEach((col, i) => {
      let max = table.headers[i]?.length ?? 10;
      for (const r of table.rows) max = Math.max(max, (r[i] ?? '').length);
      col.width = Math.min(60, max + 2);
    });
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  /** Serialize a table to a CSV Buffer with a UTF-8 BOM (Excel-VN keeps diacritics). */
  toCsv(table: ExportTable): Buffer {
    const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [table.headers, ...table.rows].map((row) => row.map(esc).join(','));
    const body = lines.join('\r\n');
    return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(body, 'utf8')]);
  }

  private async audit(user: SessionUser, action: string, payload: unknown): Promise<void> {
    const actor = await actorForUser(user);
    await withActor(actor, (tx) =>
      writeAudit(tx, {
        projectId: user.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action,
        objectType: 'export',
        newValue: payload,
      }),
    );
  }
}

function n(v: number): string {
  return String(v);
}

function labels(lang: 'vi' | 'en') {
  return lang === 'en'
    ? {
        code: 'Code', subject: 'Subject', category: 'Category', status: 'Status', requester: 'Requester',
        assignee: 'Assignee', tags: 'Tags', createdAt: 'Created at', closedAt: 'Closed at', overdue: 'Overdue (days)',
        reopenCount: 'Reopen count', month: 'Month', created: 'Created', closed: 'Closed', open: 'Open',
        reopened: 'Reopened', handled: 'Handled', uncategorized: '(Uncategorized)', unassigned: '(Unassigned)',
      }
    : {
        code: 'Mã', subject: 'Tiêu đề', category: 'Nhóm', status: 'Trạng thái', requester: 'Người gửi',
        assignee: 'Người xử lý', tags: 'Nhãn', createdAt: 'Ngày tạo', closedAt: 'Ngày đóng', overdue: 'Quá hạn (ngày)',
        reopenCount: 'Số lần mở lại', month: 'Tháng', created: 'Tạo mới', closed: 'Đã đóng', open: 'Đang mở',
        reopened: 'Mở lại', handled: 'Đã xử lý', uncategorized: '(Chưa phân nhóm)', unassigned: '(Chưa gán)',
      };
}
