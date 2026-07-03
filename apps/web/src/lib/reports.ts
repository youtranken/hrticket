import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';
import { getActiveProject } from './activeProject';

export type ReportGranularity = 'week' | 'month' | 'year';

/** A VN-day window + slicing (đơn 13 / Report v2); all optional (defaults to
 *  all-time, month buckets, every assignee on the BE). */
export interface ReportRange {
  from?: string;
  to?: string;
  /** by-time bucket size (BE default: month). */
  granularity?: ReportGranularity;
  /** Slice to one handler — Admin/TL only; a member is BE-pinned to self. */
  assigneeId?: string;
  /** Comparison window for summary deltas (same period last year). */
  prevFrom?: string;
  prevTo?: string;
}

export interface TimeBucket {
  bucket: string; // '2026-W07' | '2026-01' | '2026'
  created: number;
  handled: number; // resolved + closed now, among tickets created in the bucket
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
  handled: number;
  closed: number;
  open: number;
  overdue: number;
}
export interface StaffRow {
  assigneeId: string | null;
  name: string | null;
  holding: number; // still active
  handled: number; // resolved + closed
  overdue: number;
  avgDays: number | null; // avg resolved_at − created_at, days
  onTimePct: number | null; // % resolved within the project threshold
}

/** Header numbers for the dashboard (Report v2) — /api/reports/summary. */
export interface ReportSummary {
  total: number;
  status: {
    open: number;
    assigned: number;
    inProgress: number;
    pending: number;
    resolved: number;
    closed: number;
  };
  handled: { total: number; resolved: number; closed: number };
  active: { total: number; reopened: number; pending: number; snoozeDue: number };
  overdue: { total: number; maxDays: number };
  resolution: { avgDays: number | null; onTimePct: number | null };
  quality: { reopenedAll: number; junk: number; snoozeDue: number };
  prev: { handled: number; avgDays: number | null } | null;
  minYear: number | null;
}

function qs(range: ReportRange): string {
  const p = new URLSearchParams();
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  if (range.granularity) p.set('granularity', range.granularity);
  if (range.assigneeId) p.set('assigneeId', range.assigneeId);
  if (range.prevFrom) p.set('prevFrom', range.prevFrom);
  if (range.prevTo) p.set('prevTo', range.prevTo);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// The active project (SSA switcher) is part of the cache key so switching projects
// refetches — the api client already forwards it as the X-Project header.
function key(name: string, range: ReportRange) {
  return [
    'report',
    name,
    getActiveProject() ?? 'home',
    range.from ?? '',
    range.to ?? '',
    range.granularity ?? 'month',
    range.assigneeId ?? '',
  ] as const;
}

export function useReportSummary(range: ReportRange, enabled = true) {
  return useQuery<ReportSummary>({
    queryKey: key('summary', range),
    queryFn: () => api(`/reports/summary${qs(range)}`),
    enabled,
  });
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
