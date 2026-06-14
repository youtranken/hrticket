import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface TicketListItem {
  id: string;
  ticketCode: string;
  projectKey: string;
  subject: string;
  requesterEmail: string;
  status: string;
  category: { vi: string; en: string } | null;
  tags: { name: string; color: string | null }[];
  createdAt: string;
}

export interface TicketListResult {
  items: TicketListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export function useTickets(page: number, pageSize: number) {
  return useQuery<TicketListResult>({
    queryKey: ['tickets', page, pageSize],
    queryFn: () => api(`/tickets?page=${page}&pageSize=${pageSize}`),
  });
}

export interface TicketMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  fromAddr: string;
  toAddrs: string[] | null;
  ccAddrs: string[] | null;
  bccAddrs: string[] | null;
  bodyText: string | null;
  bodyHtmlSafe: string | null;
  isAutoReply: boolean;
  isInternal: boolean;
  createdAt: string;
}

export interface TicketParticipant {
  id: number;
  email: string;
  status: 'active' | 'pending_approval' | 'rejected';
}

export interface TicketDetail {
  ticket: {
    id: string;
    ticketCode: string;
    projectKey: string;
    projectName: string;
    subject: string;
    requesterEmail: string;
    status: string;
    category: { vi: string; en: string } | null;
    createdAt: string;
  };
  messages: TicketMessage[];
  participants: TicketParticipant[];
  tags: { name: string; color: string | null }[];
  attachments: { id: string; fileName: string; mimeType: string; size: number; status: string }[];
  links: { id: string; ticketCode: string; projectKey: string; kind: string }[];
}

export function useTicket(id: string) {
  return useQuery<TicketDetail>({
    queryKey: ['ticket', id],
    queryFn: () => api(`/tickets/${id}`),
  });
}

export function useApproveParticipant(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { participantId: number; action: 'approve' | 'reject' }) =>
      api(`/tickets/${ticketId}/participants/${vars.participantId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: vars.action }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ticket', ticketId] }),
  });
}

/** SSA sees cross-project results, so prefix the code with the project (FR14). */
export function displayCode(code: string, projectKey: string, ssa: boolean): string {
  return ssa ? `${projectKey.toUpperCase()} ${code}` : code;
}

// ── Compose: reply (3.2) / note (3.4) / draft (3.5) / upload (3.6) ──────────────

export interface ReplyDefaults {
  to: string[];
  cc: string[];
  subject: string;
  isSensitive: boolean;
}

export function useReplyDefaults(ticketId: string, enabled: boolean) {
  return useQuery<ReplyDefaults>({
    queryKey: ['reply-defaults', ticketId],
    queryFn: () => api(`/tickets/${ticketId}/reply-defaults`),
    enabled,
  });
}

export interface ReplyPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  body: string;
  attachmentIds?: string[];
  confirmNewRecipients?: boolean;
}
export type ReplyResponse =
  | { ticketMessageId: string; messageId: string }
  | { needsConfirm: true; newRecipients: string[] };

export function useReply(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<ReplyResponse, Error, ReplyPayload>({
    mutationFn: (payload) =>
      api(`/tickets/${ticketId}/replies`, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (res) => {
      if (!('needsConfirm' in res)) qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
    },
  });
}

export function useNote(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, { body: string }>({
    mutationFn: (payload) =>
      api(`/tickets/${ticketId}/notes`, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ticket', ticketId] }),
  });
}

export interface DraftView {
  body: string;
  recipients: { to?: string[]; cc?: string[]; bcc?: string[] } | null;
  updatedAt: string;
}

export function useDraft(ticketId: string, kind: 'reply' | 'note') {
  return useQuery<DraftView | null>({
    queryKey: ['draft', ticketId, kind],
    queryFn: () => api(`/tickets/${ticketId}/draft?kind=${kind}`),
  });
}

export function putDraft(
  ticketId: string,
  kind: 'reply' | 'note',
  body: string,
  recipients?: unknown,
): Promise<{ updatedAt: string }> {
  return api(`/tickets/${ticketId}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ kind, body, recipients }),
  });
}

export function deleteDraft(ticketId: string, kind: 'reply' | 'note'): Promise<unknown> {
  return api(`/tickets/${ticketId}/draft?kind=${kind}`, { method: 'DELETE' });
}

export interface UploadedAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: string;
}

/** Multipart upload — bypasses the JSON api() wrapper (different Content-Type). */
export async function uploadAttachment(
  ticketId: string,
  file: File,
): Promise<UploadedAttachment> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/tickets/${ticketId}/attachments`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((body.message as string) ?? 'Upload failed');
  return body as unknown as UploadedAttachment;
}
