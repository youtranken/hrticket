import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface TicketAssignee {
  id: string;
  name: string;
  awayFrom: string | null;
  awayTo: string | null;
}

export interface TicketListItem {
  id: string;
  ticketCode: string;
  projectKey: string;
  subject: string;
  requesterEmail: string;
  status: string;
  category: { vi: string; en: string } | null;
  assignee: TicketAssignee | null;
  tags: { name: string; color: string | null }[];
  createdAt: string;
}

export type TicketView = 'all' | 'pool' | 'mine';

export interface TicketListResult {
  items: TicketListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export function useTickets(page: number, pageSize: number, view: TicketView = 'all') {
  return useQuery<TicketListResult>({
    queryKey: ['tickets', page, pageSize, view],
    queryFn: () => api(`/tickets?page=${page}&pageSize=${pageSize}&view=${view}`),
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
    categoryId: number | null;
    assignee: TicketAssignee | null;
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

// ── Routing & assignment: claim (4.4) / assign + reclassify (4.5) / tags (4.1) ──

export function useClaim(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<{ assigneeId: string; from: string | null }, Error, { over?: boolean }>({
    mutationFn: (vars) =>
      api(`/tickets/${ticketId}/claim`, { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}

export interface AssignableUser {
  id: string;
  name: string;
  email: string;
  awayFrom: string | null;
  awayTo: string | null;
}
export function useAssignableUsers(ticketId: string, enabled: boolean) {
  return useQuery<AssignableUser[]>({
    queryKey: ['assignable-users', ticketId],
    queryFn: () => api(`/tickets/${ticketId}/assignable-users`),
    enabled,
  });
}

export interface CategoryOption {
  id: number;
  nameVi: string;
  nameEn: string;
}
export type AssignResponse =
  | { assigneeId: string; categoryId: number | null }
  | { needsCategory: true; options: CategoryOption[] };

export function useAssign(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<AssignResponse, Error, { assigneeId: string; categoryId?: number }>({
    mutationFn: (vars) =>
      api(`/tickets/${ticketId}/assign`, { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (res) => {
      if (!('needsCategory' in res)) {
        qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
        qc.invalidateQueries({ queryKey: ['tickets'] });
      }
    },
  });
}

export interface AssignCategory {
  id: number;
  nameVi: string;
  nameEn: string;
  isSystem: boolean;
}
export function useAssignCategories(ticketId: string, enabled: boolean) {
  return useQuery<AssignCategory[]>({
    queryKey: ['assign-categories', ticketId],
    queryFn: () => api(`/tickets/${ticketId}/categories`),
    enabled,
  });
}

export function useChangeCategory(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<{ categoryId: number }, Error, { categoryId: number }>({
    mutationFn: (vars) =>
      api(`/tickets/${ticketId}/category`, { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}

export interface AvailableTag {
  id: number;
  name: string;
  kind: string;
  color: string | null;
  applied: boolean;
}
export function useTicketTags(ticketId: string, enabled: boolean) {
  return useQuery<AvailableTag[]>({
    queryKey: ['ticket-tags', ticketId],
    queryFn: () => api(`/tickets/${ticketId}/tags`),
    enabled,
  });
}
export function useToggleTag(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { tagId: number; on: boolean }>({
    mutationFn: ({ tagId, on }) =>
      on
        ? api(`/tickets/${ticketId}/tags`, { method: 'POST', body: JSON.stringify({ tagId }) })
        : api(`/tickets/${ticketId}/tags/${tagId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
      qc.invalidateQueries({ queryKey: ['ticket-tags', ticketId] });
    },
  });
}

// ── Availability (4.3) ──────────────────────────────────────────────────────
export function setMyAvailability(awayFrom: string | null, awayTo: string | null): Promise<unknown> {
  return api('/me/availability', { method: 'PATCH', body: JSON.stringify({ awayFrom, awayTo }) });
}

/** Is this away window active on the given (or current) VN date? */
export function isAwayNow(awayFrom: string | null, awayTo: string | null): boolean {
  if (!awayFrom) return false;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return today >= awayFrom && (awayTo === null || today <= awayTo);
}
