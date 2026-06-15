import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface JunkRule {
  id: number;
  kind: 'keyword' | 'sender';
  pattern: string;
  createdAt: string;
}

/** Junk rules for the active project (Story 7.3). */
export function useJunkRules() {
  return useQuery<JunkRule[]>({
    queryKey: ['junk-rules'],
    queryFn: () => api('/admin/junk-rules'),
  });
}

export function useAddJunkRule() {
  const qc = useQueryClient();
  return useMutation<JunkRule, Error, { kind: 'keyword' | 'sender'; pattern: string }>({
    mutationFn: (body) => api('/admin/junk-rules', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['junk-rules'] }),
  });
}

export function useRemoveJunkRule() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, number>({
    mutationFn: (id) => api(`/admin/junk-rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['junk-rules'] }),
  });
}
