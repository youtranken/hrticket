import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface SuppressedItem {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
}
export interface SuppressedGroup {
  sender: string;
  count: number;
  items: SuppressedItem[];
}

export interface MailBombConfig {
  mailBombPerHour: number;
}

/** Held (suppressed) mails for the active project, grouped by sender (Story 7.2). */
export function useSuppressed() {
  return useQuery<SuppressedGroup[]>({
    queryKey: ['suppressed'],
    queryFn: () => api('/admin/suppressed'),
  });
}

export function useMailBombConfig() {
  return useQuery<MailBombConfig>({
    queryKey: ['mail-bomb-config'],
    queryFn: () => api('/admin/mail-bomb-config'),
  });
}

export function useSaveMailBombConfig() {
  const qc = useQueryClient();
  return useMutation<MailBombConfig, Error, MailBombConfig>({
    mutationFn: (cfg) => api('/admin/mail-bomb-config', { method: 'PUT', body: JSON.stringify(cfg) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mail-bomb-config'] }),
  });
}

export interface ReprocessResult {
  outcome: 'ticket_created' | 'appended' | 'junked';
  ticketCode?: string;
}

export function useReprocess() {
  const qc = useQueryClient();
  return useMutation<ReprocessResult, Error, string>({
    mutationFn: (id) => api(`/admin/suppressed/${id}/reprocess`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['suppressed'] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}

export function useIgnoreSuppressed() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api(`/admin/suppressed/${id}/ignore`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suppressed'] }),
  });
}
