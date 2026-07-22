import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface ReplyTemplate {
  id: number;
  title: string;
  body: string;
  /** NULL = common template (shown for every category). */
  categoryId: number | null;
  enabled: boolean;
  updatedAt: string;
}

/**
 * Canned reply templates for the active project (Story 12.2).
 * - Composer: pass `{ categoryId }` → only ENABLED templates matching that category
 *   (or common) come back.
 * - Manager: pass `{ includeDisabled: true }` → the full list incl. disabled rows.
 */
export function useReplyTemplates(opts: { categoryId?: number | null; includeDisabled?: boolean } = {}) {
  const params = new URLSearchParams();
  if (opts.categoryId != null) params.set('categoryId', String(opts.categoryId));
  if (opts.includeDisabled) params.set('includeDisabled', '1');
  const qs = params.toString();
  return useQuery<ReplyTemplate[]>({
    queryKey: ['reply-templates', opts.categoryId ?? null, !!opts.includeDisabled],
    queryFn: () => api(`/reply-templates${qs ? `?${qs}` : ''}`),
  });
}

export function useAddTemplate() {
  const qc = useQueryClient();
  return useMutation<ReplyTemplate, Error, { title: string; body: string; categoryId?: number | null }>({
    mutationFn: (b) => api('/reply-templates', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reply-templates'] }),
  });
}

export function useUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation<ReplyTemplate, Error, { id: number; title: string; body: string; categoryId?: number | null }>({
    mutationFn: ({ id, ...b }) => api(`/reply-templates/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reply-templates'] }),
  });
}

export function useSetTemplateEnabled() {
  const qc = useQueryClient();
  return useMutation<ReplyTemplate, Error, { id: number; enabled: boolean }>({
    mutationFn: ({ id, enabled }) =>
      api(`/reply-templates/${id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
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
