import i18n from '../i18n';
import { getActiveProject } from './activeProject';
import type { TicketFilters } from './tickets';

export type ExportFormat = 'xlsx' | 'csv';

/** POST a JSON body and trigger a browser download from the response blob.
 *  Surfaces a thrown Error (with the server's message) on non-2xx so the caller
 *  can toast it (e.g. the >10k EXPORT_TOO_LARGE 422). */
async function downloadPost(path: string, body: unknown): Promise<void> {
  const activeProject = getActiveProject();
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(activeProject ? { 'X-Project': activeProject } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    throw new Error(err.message ?? `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  // Filename comes from Content-Disposition; the fallback still carries a date and
  // a real extension (P2 — a bare "export" download was unidentifiable).
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename="?([^"]+)"?/.exec(cd);
  const ext = res.headers.get('Content-Type')?.includes('text/csv') ? 'csv' : 'xlsx';
  const filename =
    m?.[1] ?? `export_${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })}.${ext}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const lang = (): 'vi' | 'en' => (i18n.language === 'en' ? 'en' : 'vi');

/** Export the current ticket worklist (same filters as the list). */
export function exportTickets(filter: TicketFilters, format: ExportFormat): Promise<void> {
  return downloadPost('/export/tickets', { format, lang: lang(), filter });
}

/** Export the audit log with the reader's current filters (#55). */
export function exportAudit(
  filter: {
    from?: string;
    to?: string;
    actorId?: string;
    action?: string;
    objectType?: string;
    ticketId?: string;
    categoryId?: number;
  },
  format: ExportFormat,
): Promise<void> {
  return downloadPost('/export/audit', { format, lang: lang(), filter });
}

/** Export one report table (matches the 10.3 dashboard, incl. đơn 13 slicing). */
export function exportReport(
  kind: 'by-time' | 'by-category' | 'by-staff',
  range: { from?: string; to?: string; granularity?: 'week' | 'month' | 'year'; assigneeId?: string },
  format: ExportFormat,
): Promise<void> {
  return downloadPost('/export/report', { format, lang: lang(), kind, ...range });
}
