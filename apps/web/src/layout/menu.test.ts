import { describe, it, expect } from 'vitest';
import { menuForRole } from './menu';
import type { Me } from '../lib/auth';

const base: Omit<Me, 'role'> = {
  user: { id: '1', email: 'a@b.c', name: 'A' },
  projectId: 1,
  projectKey: 'hris',
  projects: [{ id: 1, key: 'hris', name: 'HRIS' }],
  groups: [],
  capabilities: [],
  mustChangePassword: false,
  availability: { awayFrom: null, awayTo: null },
};

function keys(role: Me['role']): string[] {
  return menuForRole({ ...base, role }).map((m) => m.key);
}

describe('menuForRole (Story 1.8 — sidebar by role)', () => {
  it('member sees inbox/my/pool/pending', () => {
    expect(keys('member')).toEqual(['inbox', 'my', 'pool', 'pending']);
  });
  it('team_lead adds reports + audit', () => {
    expect(keys('team_lead')).toContain('reports');
    expect(keys('team_lead')).not.toContain('settings');
  });
  it('admin adds junk/users/settings but not roles', () => {
    expect(keys('admin')).toContain('settings');
    expect(keys('admin')).not.toContain('roles');
  });
  it('ssa sees everything incl. role permissions', () => {
    expect(keys('ssa')).toContain('roles');
  });
});
