import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface JunkTicket {
  id: string;
  ticketCode: string;
  subject: string;
  requesterEmail: string;
  categoryLabel: string;
  isAuto: boolean;
  caughtBy: string | null;
  createdAt: string;
}

/** is_junk tickets the caller may see (RLS-scoped server-side) — Story 7.3. */
export function useJunkTickets() {
  return useQuery<JunkTicket[]>({
    queryKey: ['junk'],
    queryFn: () => api('/junk'),
  });
}

export interface ReleaseResult {
  ok: true;
  reAcked: boolean;
}

export function useReleaseJunk() {
  const qc = useQueryClient();
  return useMutation<ReleaseResult, Error, string>({
    mutationFn: (id) => api(`/junk/${id}/release`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['junk'] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}

/** "Đánh dấu Rác" — close + is_junk, optionally block the sender (Story 7.4). */
export function useMarkJunk() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; blocked: boolean }, Error, { id: string; blockSender?: boolean }>({
    mutationFn: ({ id, blockSender }) =>
      api(`/junk/${id}/mark`, { method: 'POST', body: JSON.stringify({ blockSender }) }),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: ['junk'] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['ticket', id] });
    },
  });
}

/** "Đánh dấu Spam thread" — toggle is_spam_thread (Story 7.4). */
export function useToggleSpamThread() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; isSpamThread: boolean }, Error, { id: string; on: boolean }>({
    mutationFn: ({ id, on }) =>
      api(`/junk/${id}/spam-thread`, { method: 'POST', body: JSON.stringify({ on }) }),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: ['ticket', id] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}
