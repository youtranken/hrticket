import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface ReplyTemplate {
  id: number;
  title: string;
  body: string;
  updatedAt: string;
}

/** Canned reply templates for the active project. Any agent may read (and use). */
export function useReplyTemplates() {
  return useQuery<ReplyTemplate[]>({
    queryKey: ['reply-templates'],
    queryFn: () => api('/reply-templates'),
  });
}

export function useAddTemplate() {
  const qc = useQueryClient();
  return useMutation<ReplyTemplate, Error, { title: string; body: string }>({
    mutationFn: (b) => api('/reply-templates', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reply-templates'] }),
  });
}

export function useUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation<ReplyTemplate, Error, { id: number; title: string; body: string }>({
    mutationFn: ({ id, ...b }) => api(`/reply-templates/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reply-templates'] }),
  });
}

export function useRemoveTemplate() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, number>({
    mutationFn: (id) => api(`/reply-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reply-templates'] }),
  });
}

/** Substitute {{ticketCode}}/{{requesterName}}/{{agentName}} into a template body when
 *  inserting it into a reply. Unknown/empty vars collapse to ''. */
export function fillTemplate(
  body: string,
  vars: { ticketCode?: string; requesterName?: string; agentName?: string },
): string {
  return body
    .replace(/\{\{\s*ticketCode\s*\}\}/g, vars.ticketCode ?? '')
    .replace(/\{\{\s*requesterName\s*\}\}/g, vars.requesterName ?? '')
    .replace(/\{\{\s*agentName\s*\}\}/g, vars.agentName ?? '');
}
