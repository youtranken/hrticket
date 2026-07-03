import { describe, it, expect } from 'vitest';
import { activeMenuKey, menuForRole } from './menu';
import type { Me } from '../lib/auth';

const base: Omit<Me, 'role'> = {
  user: { id: '1', email: 'a@b.c', name: 'A' },
  projectId: 1,
  projectKey: 'hris',
  projects: [{ id: 1, key: 'hris', name: 'HRIS' }],
  groups: [],
  capabilities: [],
  mustChangePassword: false,
  language: 'vi',
  availability: { awayFrom: null, awayTo: null },
  otpEnabled: false,
};

// Default capability matrix (PRD §2 seed) per role — what /me returns out of the box.
const DEFAULT_CAPS: Record<Me['role'], string[]> = {
  member: ['ticket.reply', 'ticket.claim'],
  team_lead: ['ticket.assign_others', 'log.read_group'],
  admin: ['config.manage', 'user.manage'],
  ssa: ['role.edit_capabilities', 'config.manage_all'],
};

function keys(role: Me['role'], capabilities: string[] = DEFAULT_CAPS[role]): string[] {
  return menuForRole({ ...base, role, capabilities }).flatMap((g) => g.items.map((i) => i.key));
}

describe('menuForRole (v1 redesign — consolidated grouped sidebar)', () => {
  it('member sees the ticket workspace + self report (đơn 13), no audit', () => {
    expect(keys('member')).toEqual(['inbox', 'reports']); // my/pool/pending/junk live in the in-page tab bar
    expect(keys('member')).not.toContain('audit');
  });
  it('team_lead adds reports + audit', () => {
    expect(keys('team_lead')).toContain('reports');
    expect(keys('team_lead')).toContain('audit');
    expect(keys('team_lead')).not.toContain('settings');
  });
  it('admin adds the settings hub but not roles; config pages are off the sidebar', () => {
    expect(keys('admin')).toContain('settings');
    expect(keys('admin')).not.toContain('roles');
    expect(keys('admin')).not.toContain('categories'); // consolidated into the hub
  });
  it('ssa sees everything incl. role permissions', () => {
    expect(keys('ssa')).toContain('roles');
  });

  // The /admin/roles matrix actually drives the sidebar (the reported bug): the admin
  // section follows capabilities, not the hardcoded role.
  it('settings/roles follow capabilities, not just role', () => {
    // Admin with config.manage toggled OFF loses the settings hub.
    expect(keys('admin', ['user.manage'])).not.toContain('settings');
    // Team lead granted config.manage gains the settings hub.
    expect(keys('team_lead', ['log.read_group', 'config.manage'])).toContain('settings');
    // Admin granted role.edit_capabilities gains the roles editor.
    expect(keys('admin', ['config.manage', 'role.edit_capabilities'])).toContain('roles');
  });
});

describe('activeMenuKey (prefix-resolved sidebar highlight)', () => {
  const groups = (role: Me['role']) =>
    menuForRole({ ...base, role, capabilities: DEFAULT_CAPS[role] });

  it('exact item paths highlight themselves', () => {
    expect(activeMenuKey('/inbox', groups('admin'))).toBe('/inbox');
    expect(activeMenuKey('/reports', groups('admin'))).toBe('/reports');
    expect(activeMenuKey('/admin/settings', groups('admin'))).toBe('/admin/settings');
  });

  it('ticket-workspace children light up Inbox', () => {
    for (const p of ['/tickets/123', '/my-tickets', '/pool', '/pending', '/junk', '/search']) {
      expect(activeMenuKey(p, groups('admin'))).toBe('/inbox');
    }
  });

  it('config child pages light up the Settings hub; roles keeps its own entry', () => {
    expect(activeMenuKey('/admin/groups', groups('admin'))).toBe('/admin/settings');
    expect(activeMenuKey('/admin/users', groups('admin'))).toBe('/admin/settings');
    expect(activeMenuKey('/admin/categories', groups('admin'))).toBe('/admin/settings');
    const ssa = menuForRole({
      ...base,
      role: 'ssa',
      capabilities: ['role.edit_capabilities', 'config.manage_all'],
    });
    expect(activeMenuKey('/admin/roles', ssa)).toBe('/admin/roles');
    expect(activeMenuKey('/admin/roles/whatever', ssa)).toBe('/admin/roles');
  });

  it('unknown / profile routes highlight nothing', () => {
    expect(activeMenuKey('/profile', groups('admin'))).toBeUndefined();
    expect(activeMenuKey('/nonsense', groups('member'))).toBeUndefined();
  });
});
