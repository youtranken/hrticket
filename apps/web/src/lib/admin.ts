import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: boolean;
  projectId: number | null;
  awayFrom?: string | null;
  awayTo?: string | null;
}

export interface AutoAssignMember {
  userId: string;
  name: string;
  position: number;
}
export interface AdminCategory {
  id: number;
  nameVi: string;
  nameEn: string;
  isSensitive: boolean;
  isSystem: boolean;
  disabled: boolean;
  keywords: string[];
  ticketCount: number;
  autoAssign: { strategy: string; members: AutoAssignMember[] } | null;
}

export interface AdminTag {
  id: number;
  name: string;
  kind: string;
  color: string | null;
  keywords: string[];
  ticketCount: number;
}

export function useAdminUsers() {
  return useQuery<AdminUser[]>({ queryKey: ['admin', 'users'], queryFn: () => api('/admin/users') });
}

export function useAdminCategories() {
  return useQuery<AdminCategory[]>({
    queryKey: ['admin', 'categories'],
    queryFn: () => api('/admin/categories'),
  });
}

export function createCategory(input: {
  nameVi: string;
  nameEn: string;
  isSensitive?: boolean;
  keywords?: string[];
}): Promise<{ id: number }> {
  return api('/admin/categories', { method: 'POST', body: JSON.stringify(input) });
}
export function updateCategory(
  id: number,
  patch: { nameVi?: string; nameEn?: string; isSensitive?: boolean; disabled?: boolean; keywords?: string[] },
): Promise<{ ok: true }> {
  return api(`/admin/categories/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteCategory(id: number): Promise<{ ok: true }> {
  return api(`/admin/categories/${id}`, { method: 'DELETE' });
}
export function putAutoAssign(
  id: number,
  input: { strategy: 'round_robin' | 'least_load'; members: string[] },
): Promise<{ ok: true }> {
  return api(`/admin/categories/${id}/auto-assign`, { method: 'PUT', body: JSON.stringify(input) });
}

export function useAdminTags() {
  return useQuery<AdminTag[]>({ queryKey: ['admin', 'tags'], queryFn: () => api('/admin/tags') });
}
export function createTag(input: {
  name: string;
  kind: 'manual' | 'priority';
  color?: string;
  keywords?: string[];
}): Promise<{ id: number }> {
  return api('/admin/tags', { method: 'POST', body: JSON.stringify(input) });
}
export function updateTag(
  id: number,
  patch: { name?: string; color?: string; keywords?: string[] },
): Promise<{ ok: true }> {
  return api(`/admin/tags/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteTag(
  id: number,
  confirm = false,
): Promise<{ ok: true } | { needsConfirm: true; attachedTo: number }> {
  return api(`/admin/tags/${id}?confirm=${confirm}`, { method: 'DELETE' });
}

export function setUserAvailability(
  userId: string,
  awayFrom: string | null,
  awayTo: string | null,
): Promise<unknown> {
  return api(`/users/${userId}/availability`, {
    method: 'PATCH',
    body: JSON.stringify({ awayFrom, awayTo }),
  });
}
