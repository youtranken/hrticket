import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from './apiClient';

export interface AuditRow {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  objectType: string | null;
  objectId: string | null;
  oldValue: unknown;
  newValue: unknown;
  /** Human-readable object ("#code · subject" / "name (email)"); null → fall back to type:id. */
  objectLabel: string | null;
  /** Ticket code when objectType='ticket' (for a distinct #code + link). */
  ticketCode: string | null;
}

export interface ViewLogRow {
  id: number;
  createdAt: string;
  action: 'ticket_view' | 'file_download';
  actorId: string;
  actorName: string;
  actorEmail: string;
  ticketId: string;
  ticketCode: string;
  attachmentId: string | null;
  fileName: string | null;
}

export interface AuditFilters {
  from?: string;
  to?: string;
  action?: string;
  objectType?: string;
  ticketId?: string;
  page?: number;
  pageSize?: number;
}

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

function qs(f: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useAudit(f: AuditFilters) {
  return useQuery<Paged<AuditRow>>({
    queryKey: ['audit', f],
    queryFn: () => api(`/audit${qs(f as Record<string, string | number | undefined>)}`),
    placeholderData: keepPreviousData,
  });
}

export function useViewLog(f: { ticketId?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
  return useQuery<Paged<ViewLogRow>>({
    queryKey: ['audit', 'view-log', f],
    queryFn: () => api(`/audit/view-log${qs(f)}`),
    placeholderData: keepPreviousData,
  });
}
