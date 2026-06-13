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

export async function login(email: string, password: string): Promise<{ otpRequired: boolean }> {
  return api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export async function logout(): Promise<void> {
  await api('/auth/logout', { method: 'POST' });
}
