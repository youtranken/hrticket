import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';
import { setActiveProject } from './activeProject';

export interface ProjectRef {
  id: number;
  key: string;
  name: string;
}

export interface Me {
  user: { id: string; email: string; name: string };
  role: 'ssa' | 'admin' | 'team_lead' | 'member';
  projectId: number | null;
  projectKey: string;
  projects: ProjectRef[];
  groups: number[];
  capabilities: string[];
  mustChangePassword: boolean;
  /** Per-account UI language (Story 11.2) — applied on login from any machine. */
  language: string;
  availability: { awayFrom: string | null; awayTo: string | null };
  /** Whether OTP 2FA is on — drives the Profile security switch. */
  otpEnabled: boolean;
}

/**
 * True when the user's role currently holds the capability (SSA matrix, FR55).
 * The BE enforces via CapabilityGuard — this only hides/disables dead controls.
 * `null | undefined` me → false (nothing capability-gated shows while loading).
 */
export function hasCap(me: Me | null | undefined, cap: string): boolean {
  return !!me?.capabilities.includes(cap);
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

/** Re-issue the login code; returns a FRESH pre-auth token the next verify must use. */
export async function resendOtp(preAuthToken: string): Promise<string> {
  const res = await api<{ preAuthToken: string }>('/auth/otp/resend', {
    method: 'POST',
    body: JSON.stringify({ preAuthToken }),
  });
  return res.preAuthToken;
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

/** Persist the UI language to the account so it follows the user across machines. */
export async function setServerLanguage(language: 'vi' | 'en'): Promise<void> {
  await api('/me/language', { method: 'PATCH', body: JSON.stringify({ language }) });
}

export async function logout(): Promise<void> {
  await api('/auth/logout', { method: 'POST' });
  setActiveProject(null); // don't leak an SSA's project choice into the next session
}
