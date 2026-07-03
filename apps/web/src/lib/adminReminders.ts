import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface ReminderConfig {
  overdueDays: number;
  digestHour: number;
  /** Đơn 12: minute of the send time (08:30 default). */
  digestMinute: number;
  digestEnabled: boolean;
  digestMaxN: number;
  /** Đơn 12: pool ticket unclaimed >= this many days → admin digest section 1. */
  poolUnclaimedDays: number;
}

export function useReminderConfig() {
  return useQuery<ReminderConfig>({
    queryKey: ['reminder-config'],
    queryFn: () => api('/admin/reminder-config'),
  });
}

export function useSaveReminderConfig() {
  const qc = useQueryClient();
  return useMutation<ReminderConfig, Error, ReminderConfig>({
    mutationFn: (cfg) => api('/admin/reminder-config', { method: 'PUT', body: JSON.stringify(cfg) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reminder-config'] });
      qc.invalidateQueries({ queryKey: ['tickets'] }); // overdue threshold changed
    },
  });
}

export interface EmailTemplate {
  key: string;
  subjectVi: string;
  subjectEn: string;
  bodyVi: string;
  bodyEn: string;
  placeholders: string[];
}

export function useEmailTemplates() {
  return useQuery<EmailTemplate[]>({
    queryKey: ['email-templates'],
    queryFn: () => api('/admin/email-templates'),
  });
}

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean },
    Error,
    { key: string; subjectVi: string; subjectEn: string; bodyVi: string; bodyEn: string }
  >({
    mutationFn: ({ key, ...body }) =>
      api(`/admin/email-templates/${key}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-templates'] }),
  });
}

export function testSendTemplate(key: string): Promise<{ to: string }> {
  return api(`/admin/email-templates/${key}/test-send`, { method: 'POST' });
}
