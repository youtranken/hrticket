import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface NotificationItem {
  id: number;
  type: string;
  payload:
    | {
        ticketId?: string;
        ticketCode?: string;
        by?: string;
        reason?: string;
        // Worker-liveness alert: which loops are down (FE translates the names).
        loops?: string[];
        // Per-mailbox alert (mailbox_down): which project + the error text.
        projectKey?: string;
        projectName?: string;
        error?: string;
      }
    | null;
  readAt: string | null;
  createdAt: string;
}

interface NotifState {
  items: NotificationItem[];
  unreadCount: number;
  /** Last-Modified header from the last 200 — sent as If-Modified-Since to get 304s. */
  lastModified: string | null;
}

const KEY = ['notifications'];

/**
 * Bell poller (Story 6.1): every 15s while the tab is focused, conditional-GET the
 * notification list. A 304 returns the SAME state reference (no re-render); a 200
 * carries only the delta, which we merge on top of what we already hold. ≥10s & ≤30s
 * per NFR16. Direct fetch (not api()) so we can read the Last-Modified header + 304.
 */
export function useNotifications() {
  const qc = useQueryClient();
  return useQuery<NotifState>({
    queryKey: KEY,
    initialData: { items: [], unreadCount: 0, lastModified: null },
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const prev = qc.getQueryData<NotifState>(KEY) ?? { items: [], unreadCount: 0, lastModified: null };
      const res = await fetch('/api/notifications', {
        credentials: 'include',
        headers: prev.lastModified ? { 'If-Modified-Since': prev.lastModified } : {},
      });
      if (res.status === 304) return prev; // unchanged → stable ref, no churn
      const lastModified = res.headers.get('Last-Modified') ?? prev.lastModified;
      const body = (await res.json()) as { items: NotificationItem[]; unreadCount: number };
      const incomingIds = new Set(body.items.map((i) => i.id));
      const merged = [...body.items, ...prev.items.filter((i) => !incomingIds.has(i.id))].slice(0, 50);
      return { items: merged, unreadCount: body.unreadCount, lastModified };
    },
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, number, { prev?: NotifState }>({
    mutationFn: (id) => api(`/notifications/${id}/read`, { method: 'PATCH' }),
    onMutate: (id) => {
      // Optimistic: flip readAt + drop the unread count locally so the badge reacts now.
      const prev = qc.getQueryData<NotifState>(KEY);
      qc.setQueryData<NotifState>(KEY, (s) =>
        s
          ? {
              ...s,
              items: s.items.map((i) => (i.id === id && !i.readAt ? { ...i, readAt: new Date().toISOString() } : i)),
              unreadCount: Math.max(0, s.unreadCount - (s.items.find((i) => i.id === id && !i.readAt) ? 1 : 0)),
            }
          : s,
      );
      return { prev };
    },
    // The 304 watermark means a failed optimistic flip would otherwise become permanent
    // (the poll won't re-send an unchanged row) — restore the snapshot on error.
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData<NotifState>(KEY, ctx.prev);
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, void, { prev?: NotifState }>({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onMutate: () => {
      const prev = qc.getQueryData<NotifState>(KEY);
      qc.setQueryData<NotifState>(KEY, (s) =>
        s ? { ...s, items: s.items.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })), unreadCount: 0 } : s,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData<NotifState>(KEY, ctx.prev);
    },
  });
}
