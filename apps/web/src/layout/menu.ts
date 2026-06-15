import type { Me } from '../lib/auth';

export interface MenuEntry {
  key: string;
  path: string;
  labelKey: string;
}

/**
 * Permission-driven menu (Story 1.8). Hiding a menu item is UX only — the
 * backend still enforces access via Guards + RLS. Roles are cumulative.
 */
export function menuForRole(me: Me): MenuEntry[] {
  const member: MenuEntry[] = [
    { key: 'inbox', path: '/inbox', labelKey: 'menu.inbox' },
    { key: 'my', path: '/my-tickets', labelKey: 'menu.myTickets' },
    { key: 'pool', path: '/pool', labelKey: 'menu.pool' },
    { key: 'pending', path: '/pending', labelKey: 'menu.pending' },
  ];
  const teamLead: MenuEntry[] = [
    { key: 'reports', path: '/reports', labelKey: 'menu.reports' },
    { key: 'audit', path: '/audit', labelKey: 'menu.audit' },
  ];
  const admin: MenuEntry[] = [
    { key: 'categories', path: '/admin/categories', labelKey: 'menu.categories' },
    { key: 'groups', path: '/admin/groups', labelKey: 'groups.nav' },
    { key: 'reminders', path: '/admin/reminders', labelKey: 'menu.reminders' },
    { key: 'mailProtection', path: '/admin/mail-protection', labelKey: 'spam.nav.mailProtection' },
    { key: 'attachmentConfig', path: '/admin/attachments', labelKey: 'files.nav.attachmentConfig' },
    { key: 'emailConnection', path: '/admin/email-connection', labelKey: 'conn.nav' },
    { key: 'junk', path: '/junk', labelKey: 'menu.junk' },
    { key: 'users', path: '/admin/users', labelKey: 'menu.users' },
    { key: 'settings', path: '/admin/settings', labelKey: 'menu.settings' },
  ];
  const ssa: MenuEntry[] = [{ key: 'roles', path: '/admin/roles', labelKey: 'menu.roles' }];

  switch (me.role) {
    case 'member':
      return member;
    case 'team_lead':
      return [...member, ...teamLead];
    case 'admin':
      return [...member, ...teamLead, ...admin];
    case 'ssa':
      return [...member, ...teamLead, ...admin, ...ssa];
    default:
      return member;
  }
}
