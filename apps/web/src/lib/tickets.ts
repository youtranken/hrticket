import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface TicketAssignee {
  id: string;
  name: string;
  /** Holder's role — only the ticket detail provides it (drives claim-over gating). */
  role?: 'member' | 'team_lead' | 'admin' | 'ssa';
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
  tags: { name: string; color: string | null; kind?: string }[];
  createdAt: string;
  isOverdue: boolean;
  overdueDays: number;
  snoozeUntil: string | null;
  snoozeDue: boolean;
  reopenCount: number;
  categorySensitive?: boolean;
  isJunk?: boolean;
  isSpamThread?: boolean;
  /** First staff read (ISO) or null = unread. "Mới" shows only while unread AND unassigned. */
  firstReadAt?: string | null;
}

export type TicketView = 'all' | 'pool' | 'mine' | 'pending';
export type TicketSort = 'worklist' | 'created' | 'status' | 'snooze' | 'category' | 'assignee';
export type SortDir = 'asc' | 'desc';

/** Filter bar state (Story 10.1, FR79). Mirrors the BE Zod `ticketListQuerySchema`;
 *  Phase-C keeps `packages/shared` frozen, so the type lives here too. */
export interface TicketFilters {
  view?: TicketView;
  sort?: TicketSort;
  dir?: SortDir;
  status?: string[];
  categoryId?: number[];
  tagId?: number[];
  assigneeId?: string[];
  projectId?: number;
  createdFrom?: string; // 'YYYY-MM-DD' (VN day)
  createdTo?: string;
}

export interface TicketListResult {
  items: TicketListItem[];
  total: number;
  page: number;
  pageSize: number;
  overdueTotal: number;
}

/** Build the query string for `GET /api/tickets`; arrays go as repeated params. */
export function ticketListQueryString(page: number, pageSize: number, f: TicketFilters): string {
  const p = new URLSearchParams();
  p.set('page', String(page));
  p.set('pageSize', String(pageSize));
  if (f.view) p.set('view', f.view);
  if (f.sort) p.set('sort', f.sort);
  if (f.dir) p.set('dir', f.dir);
  for (const s of f.status ?? []) p.append('status', s);
  for (const c of f.categoryId ?? []) p.append('categoryId', String(c));
  for (const t of f.tagId ?? []) p.append('tagId', String(t));
  for (const a of f.assigneeId ?? []) p.append('assigneeId', a);
  if (f.projectId !== undefined) p.set('projectId', String(f.projectId));
  if (f.createdFrom) p.set('createdFrom', f.createdFrom);
  if (f.createdTo) p.set('createdTo', f.createdTo);
  return p.toString();
}

export function useTickets(page: number, pageSize: number, filters: TicketFilters = {}) {
  return useQuery<TicketListResult>({
    queryKey: ['tickets', page, pageSize, filters],
    queryFn: () => api(`/tickets?${ticketListQueryString(page, pageSize, filters)}`),
  });
}

/** Lightweight poll (1 row) for the live total of the current filter — drives the
 *  "N new tickets" pill without disturbing the displayed page. */
export function useTicketTotal(filters: TicketFilters, refetchInterval: number) {
  return useQuery<TicketListResult>({
    queryKey: ['tickets-poll', filters],
    queryFn: () => api(`/tickets?${ticketListQueryString(1, 1, filters)}`),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

/** Always-visible tab-bar "folder counts" (mine / pool / pending). Polled so a user on
 *  /inbox still sees what's waiting elsewhere; kept fresh by claim/assign/status mutations
 *  invalidating ['ticket-counts']. */
export interface TicketCounts {
  mine: number;
  pool: number;
  pending: number;
}
export function useTicketCounts(refetchInterval = 20_000) {
  return useQuery<TicketCounts>({
    queryKey: ['ticket-counts'],
    queryFn: () => api('/tickets/counts'),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export interface FilterOptions {
  categories: { id: number; nameVi: string; nameEn: string }[];
  // `disabled` flags ex-assignees who are turned off: the FILTER bar still lists them
  // (so historical tickets stay filterable), but assignment pickers exclude them.
  assignees: { id: string; name: string; disabled: boolean }[];
  tags: { id: number; name: string; color: string | null }[];
}

/** RLS-scoped options for the filter dropdowns (categories/assignees/tags). */
export function useFilterOptions() {
  return useQuery<FilterOptions>({
    queryKey: ['ticket-filter-options'],
    queryFn: () => api('/tickets/filter-options'),
  });
}

// Imperative manual-tag add/remove for the inline worklist picker (FR33). The hook
// form (useTicketTags / useToggleTag) lives further down for the ticket-detail page.
export function addTicketTag(ticketId: string, tagId: number): Promise<{ ok: true }> {
  return api(`/tickets/${ticketId}/tags`, { method: 'POST', body: JSON.stringify({ tagId }) });
}
export function removeTicketTag(ticketId: string, tagId: number): Promise<{ ok: true }> {
  return api(`/tickets/${ticketId}/tags/${tagId}`, { method: 'DELETE' });
}

// ── Full-text search (Story 10.2, FR81) ─────────────────────────────────────

export type SearchMatchType = 'code' | 'subject' | 'body' | 'requester' | 'assignee';

export interface SearchResultItem {
  id: string;
  ticketCode: string;
  projectKey: string;
  subject: string;
  requesterEmail: string;
  status: string;
  category: { vi: string; en: string } | null;
  assignee: { id: string; name: string } | null;
  createdAt: string;
  matchType: SearchMatchType;
  /** ts_headline snippet with matched terms wrapped in <b> (may be null). */
  headline: string | null;
}

export interface SearchResult {
  items: SearchResultItem[];
  total: number;
  page: number;
  pageSize: number;
}

export type SearchSort = 'relevance' | 'created' | 'status';

/** Vietnamese FTS + code + people search. `enabled` lets the dropdown debounce. */
export function useTicketSearch(
  q: string,
  page = 1,
  pageSize = 20,
  enabled = true,
  order: { sort: SearchSort; dir: SortDir } = { sort: 'relevance', dir: 'desc' },
) {
  const trimmed = q.trim();
  return useQuery<SearchResult>({
    queryKey: ['ticket-search', trimmed, page, pageSize, order.sort, order.dir],
    queryFn: () =>
      api(
        `/tickets/search?q=${encodeURIComponent(trimmed)}&page=${page}&pageSize=${pageSize}&sort=${order.sort}&dir=${order.dir}`,
      ),
    enabled: enabled && trimmed.length > 0,
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
  /** Cross-post merge: which project's ticket this message belongs to (a sibling's
   *  message carries the OTHER project key → the bubble shows an origin tag). */
  fromProjectKey?: string | null;
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
    categorySensitive?: boolean;
    /** True for the system "Khác"/Other bucket — gates claim-from-Khác UX (đơn 5). */
    categoryIsSystem?: boolean;
    assignee: TicketAssignee | null;
    createdAt: string;
    snoozeUntil: string | null;
    reopenCount: number;
    reopenLocked: boolean;
    isJunk?: boolean;
    isSpamThread?: boolean;
    isOverdue: boolean;
    overdueDays: number;
    snoozeDue: boolean;
  };
  messages: TicketMessage[];
  participants: TicketParticipant[];
  tags: { name: string; color: string | null }[];
  attachments: { id: string; messageId: string | null; fileName: string; mimeType: string; size: number; status: string }[];
  links: { id: string; ticketCode: string; projectKey: string; kind: string }[];
}

export function useTicket(id: string) {
  return useQuery<TicketDetail>({
    queryKey: ['ticket', id],
    queryFn: () => api(`/tickets/${id}`),
  });
}

/** Đơn 16 — every ticket this ticket's requester has sent (⋮ menu). RLS-scoped:
 *  the caller only ever counts tickets they could see in the worklist anyway. */
export interface RequesterHistory {
  email: string;
  total: number;
  active: number;
  junk: number;
  items: {
    id: string;
    ticketCode: string;
    subject: string;
    status: string;
    isJunk: boolean;
    isSpamThread: boolean;
    createdAt: string;
  }[];
}

export function useRequesterHistory(ticketId: string, enabled: boolean) {
  return useQuery<RequesterHistory>({
    queryKey: ['ticket', ticketId, 'requester-history'],
    queryFn: () => api(`/tickets/${ticketId}/requester-history`),
    enabled,
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
  /** Only populated when WE sent the latest mail (an inbound's BCC is invisible). */
  bcc: string[];
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
  closeAfter?: boolean;
  /** Send-with-status (đơn 6): snooze (needs snoozeUntil) or resolve in one action. */
  statusAfter?: 'pending' | 'resolved';
  snoozeUntil?: string;
}
export type ReplyResponse =
  | { ticketMessageId: string; messageId: string; closed: boolean; status?: string }
  | { needsConfirm: true; newRecipients: string[] };

export function useReply(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<ReplyResponse, Error, ReplyPayload>({
    mutationFn: (payload) =>
      api(`/tickets/${ticketId}/replies`, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (res) => {
      if (!('needsConfirm' in res)) {
        qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
        // Send-with-status moves the ticket between tabs — keep lists/badges honest.
        qc.invalidateQueries({ queryKey: ['tickets'] });
        qc.invalidateQueries({ queryKey: ['tickets-poll'] });
        qc.invalidateQueries({ queryKey: ['ticket-counts'] });
      }
    },
  });
}

export interface ForwardPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  body?: string;
  ticketMessageId: string;
  confirmNewRecipients?: boolean;
}
export type ForwardResponse =
  | { ticketMessageId: string; messageId: string }
  | { needsConfirm: true; newRecipients: string[] };

export function useForward(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<ForwardResponse, Error, ForwardPayload>({
    mutationFn: (payload) =>
      api(`/tickets/${ticketId}/forward`, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (res) => {
      if (!('needsConfirm' in res)) {
        qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
        // The forward is now the LATEST mail → the reply-all suggestion follows it.
        qc.invalidateQueries({ queryKey: ['reply-defaults', ticketId] });
      }
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

// ── Manual ticket: create an internal ticket + send the opening mail (multipart) ──

export interface ManualTicketPayload {
  recipientEmail: string;
  subject: string;
  body: string;
  categoryId?: number;
  assigneeId?: string;
  files: File[];
}

/** Multipart POST (fields + attachments in one request) — bypasses the JSON api()
 *  wrapper, like uploadAttachment. The BE derives the project from the session. */
export async function createManualTicket(
  p: ManualTicketPayload,
): Promise<{ ticketId: string; ticketCode: string }> {
  const form = new FormData();
  form.append('recipientEmail', p.recipientEmail);
  form.append('subject', p.subject);
  form.append('body', p.body);
  if (p.categoryId != null) form.append('categoryId', String(p.categoryId));
  if (p.assigneeId) form.append('assigneeId', p.assigneeId);
  for (const f of p.files) form.append('files', f);
  const res = await fetch('/api/tickets/manual', { method: 'POST', credentials: 'include', body: form });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((body.message as string) ?? 'Create failed');
  return body as { ticketId: string; ticketCode: string };
}

// ── Routing & assignment: claim (4.4) / assign + reclassify (4.5) / tags (4.1) ──

export type ClaimResponse =
  | { assigneeId: string; from: string | null }
  // Member claiming from "Khác" with several groups → must pick the destination (đơn 5).
  | { needsCategory: true; options: CategoryOption[] };

export function useClaim(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<ClaimResponse, Error, { over?: boolean; categoryId?: number }>({
    mutationFn: (vars) =>
      api(`/tickets/${ticketId}/claim`, { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (res) => {
      if ('needsCategory' in res) return; // nothing changed yet — the picker retries
      qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['tickets-poll'] }); // keep the "N new" pill honest
      qc.invalidateQueries({ queryKey: ['ticket-counts'] }); // refresh tab badges
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
        qc.invalidateQueries({ queryKey: ['tickets-poll'] });
        qc.invalidateQueries({ queryKey: ['ticket-counts'] });
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
      qc.invalidateQueries({ queryKey: ['tickets-poll'] });
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

// ── Lifecycle: status transition (5.1/5.2/5.5) + reopen lock (5.4) ──────────────

export interface ChangeStatusPayload {
  to: string;
  snoozeUntil?: string;
  note?: string;
  reason?: 'junk' | 'duplicate';
}
export function useChangeStatus(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, Error, ChangeStatusPayload>({
    mutationFn: (payload) =>
      api(`/tickets/${ticketId}/status`, { method: 'PATCH', body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['tickets-poll'] });
      qc.invalidateQueries({ queryKey: ['ticket-counts'] });
    },
  });
}

export function useSetReopenLock(ticketId: string) {
  const qc = useQueryClient();
  return useMutation<{ reopenLocked: boolean }, Error, { locked: boolean }>({
    mutationFn: (payload) =>
      api(`/tickets/${ticketId}/reopen-lock`, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ticket', ticketId] }),
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
