import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';

export interface Me {
  user: { id: string; email: string; name: string };
  role: 'ssa' | 'admin' | 'team_lead' | 'member';
  projectId: number | null;
  groups: number[];
  capabilities: string[];
  mustChangePassword: boolean;
}

/** Loads the current user; null when unauthenticated. */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/me');
      } catch {
        return null;
      }
    },
    retry: false,
  });
}

export async function login(
  email: string,
  password: string,
): Promise<{ otpRequired: boolean; preAuthToken?: string }> {
  return api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export async function verifyOtp(preAuthToken: string, code: string): Promise<void> {
  await api('/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ preAuthToken, code }),
  });
}

export async function forgotPassword(email: string): Promise<void> {
  await api('/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await api('/auth/reset', { method: 'POST', body: JSON.stringify({ token, password }) });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await api('/me/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function toggleOtp(enabled: boolean, password: string): Promise<void> {
  await api('/me/otp', { method: 'PATCH', body: JSON.stringify({ enabled, password }) });
}

export async function logout(): Promise<void> {
  await api('/auth/logout', { method: 'POST' });
}
