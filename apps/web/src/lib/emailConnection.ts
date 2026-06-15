import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface EmailConnection {
  source: 'db' | 'env';
  imapHost: string | null;
  imapPort: number | null;
  imapUser: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  /** `****<last4>` of the stored App Password, or null when none is set. */
  passwordMask: string | null;
  status: string;
  lastCheckedAt: string | null;
}

export interface EmailConnectionInput {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  /** Omit to keep the stored App Password unchanged. */
  password?: string;
}

export interface TestLeg {
  ok: boolean;
  messages?: number;
  error?: string;
}

export interface TestResult {
  imap: TestLeg;
  smtp: TestLeg;
}

export function useEmailConnection() {
  return useQuery<EmailConnection>({
    queryKey: ['email-connection'],
    queryFn: () => api('/admin/email-connection'),
  });
}

export function useSaveEmailConnection() {
  const qc = useQueryClient();
  return useMutation<EmailConnection, Error, EmailConnectionInput>({
    mutationFn: (body) =>
      api('/admin/email-connection', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-connection'] }),
  });
}

export function useTestConnection() {
  return useMutation<TestResult, Error, EmailConnectionInput>({
    mutationFn: (body) =>
      api('/admin/email-connection/test-connection', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}
