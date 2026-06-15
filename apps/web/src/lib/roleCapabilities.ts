import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';

export type CapRole = 'member' | 'team_lead' | 'admin' | 'ssa';

export interface CapabilityCell {
  role: CapRole;
  allowed: boolean;
  locked: boolean;
}
export interface CapabilityRow {
  capability: string;
  cells: CapabilityCell[];
}
export interface CapabilityMatrix {
  roles: CapRole[];
  rows: CapabilityRow[];
}

/** SSA role × capability matrix (Story 9.4). */
export function useRoleCapabilities() {
  return useQuery<CapabilityMatrix>({
    queryKey: ['ssa', 'role-capabilities'],
    queryFn: () => api('/ssa/role-capabilities'),
  });
}

export function setCapabilityCell(
  role: CapRole,
  capability: string,
  allowed: boolean,
): Promise<{ ok: true }> {
  return api('/ssa/role-capabilities', {
    method: 'PUT',
    body: JSON.stringify({ role, capability, allowed }),
  });
}

export function resetCapabilities(): Promise<{ ok: true }> {
  return api('/ssa/role-capabilities/reset', { method: 'POST' });
}
