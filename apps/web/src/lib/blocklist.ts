import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface BlocklistEntry {
  id: number;
  email: string;
  reason: string | null;
  addedByEmail: string | null;
  createdAt: string;
  blockedCount: number;
}

/** Blocked senders for the active project (Story 7.1, FR100). */
export function useBlocklist() {
  return useQuery<BlocklistEntry[]>({
    queryKey: ['blocklist'],
    queryFn: () => api('/admin/blocklist'),
  });
}

export function useAddBlock() {
  const qc = useQueryClient();
  return useMutation<BlocklistEntry, Error, { email: string; reason?: string }>({
    mutationFn: (body) => api('/admin/blocklist', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blocklist'] }),
  });
}

export function useRemoveBlock() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, number>({
    mutationFn: (id) => api(`/admin/blocklist/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blocklist'] }),
  });
}
