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
