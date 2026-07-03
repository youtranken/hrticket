import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface AllowlistEntry {
  id: number;
  email: string;
  reason: string | null;
  addedByEmail: string | null;
  createdAt: string;
  /** How many inbound mails this address has had let through (audit-derived). */
  allowedCount: number;
}

/** Allowlisted senders for the active project (twin of the blocklist). */
export function useAllowlist() {
  return useQuery<AllowlistEntry[]>({
    queryKey: ['allowlist'],
    queryFn: () => api('/admin/allowlist'),
  });
}

export function useAddAllow() {
  const qc = useQueryClient();
  return useMutation<AllowlistEntry, Error, { email: string; reason?: string }>({
    mutationFn: (body) => api('/admin/allowlist', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['allowlist'] }),
  });
}

export function useRemoveAllow() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, number>({
    mutationFn: (id) => api(`/admin/allowlist/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['allowlist'] }),
  });
}
