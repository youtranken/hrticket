import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';

export interface AdminGroup {
  categoryId: number;
  nameVi: string;
  nameEn: string;
  isSensitive: boolean;
  isSystem: boolean;
  memberCount: number;
}

export interface GroupMember {
  id: string;
  name: string;
  email: string;
  role: string;
  disabled: boolean;
  inGroup: boolean;
}

/** Category groups in the active project + their member counts (Story 9.1). */
export function useGroups() {
  return useQuery<AdminGroup[]>({ queryKey: ['admin', 'groups'], queryFn: () => api('/admin/groups') });
}

/** Project users split in/out of one group — feeds the transfer list. */
export function useGroupMembers(categoryId: number | null) {
  return useQuery<GroupMember[]>({
    queryKey: ['admin', 'groups', categoryId, 'members'],
    queryFn: () => api(`/admin/groups/${categoryId}/members`),
    enabled: categoryId !== null,
  });
}

export function setGroupMembers(
  categoryId: number,
  userIds: string[],
): Promise<{ added: string[]; removed: string[] }> {
  return api(`/admin/groups/${categoryId}/members`, {
    method: 'PUT',
    body: JSON.stringify({ userIds }),
  });
}

/** Reverse direction: the groups a single user belongs to. */
export function useUserGroups(userId: string | null) {
  return useQuery<number[]>({
    queryKey: ['admin', 'groups', 'by-user', userId],
    queryFn: () => api(`/admin/groups/by-user/${userId}`),
    enabled: userId !== null,
  });
}

export function setUserGroups(
  userId: string,
  categoryIds: number[],
): Promise<{ added: number[]; removed: number[] }> {
  return api(`/admin/groups/by-user/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ categoryIds }),
  });
}
