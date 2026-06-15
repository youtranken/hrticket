import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';
import { getActiveProject } from './activeProject';

/** A VN-day window; both optional (defaults to all-time on the BE). */
export interface ReportRange {
  from?: string;
  to?: string;
}

export interface TimeBucket {
  bucket: string; // 'YYYY-MM'
  created: number;
  closed: number;
  open: number;
  overdue: number;
  reopened: number;
}
export interface CategoryRow {
  categoryId: number | null;
  nameVi: string | null;
  nameEn: string | null;
  created: number;
  closed: number;
  open: number;
  overdue: number;
}
export interface StaffRow {
  assigneeId: string | null;
  name: string | null;
  handled: number;
  closed: number;
  open: number;
  overdue: number;
}

function qs(range: ReportRange): string {
  const p = new URLSearchParams();
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// The active project (SSA switcher) is part of the cache key so switching projects
// refetches — the api client already forwards it as the X-Project header.
function key(name: string, range: ReportRange) {
  return ['report', name, getActiveProject() ?? 'home', range.from ?? '', range.to ?? ''] as const;
}

export function useReportByTime(range: ReportRange, enabled = true) {
  return useQuery<{ buckets: TimeBucket[] }>({
    queryKey: key('by-time', range),
    queryFn: () => api(`/reports/by-time${qs(range)}`),
    enabled,
  });
}
export function useReportByCategory(range: ReportRange, enabled = true) {
  return useQuery<{ categories: CategoryRow[] }>({
    queryKey: key('by-category', range),
    queryFn: () => api(`/reports/by-category${qs(range)}`),
    enabled,
  });
}
export function useReportByStaff(range: ReportRange, enabled = true) {
  return useQuery<{ staff: StaffRow[] }>({
    queryKey: key('by-staff', range),
    queryFn: () => api(`/reports/by-staff${qs(range)}`),
    enabled,
  });
}
