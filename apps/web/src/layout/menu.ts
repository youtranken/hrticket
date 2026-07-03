import type { Me } from '../lib/auth';

export interface NavItem {
  key: string;
  path: string;
  labelKey: string;
  /** Icon id resolved to a component in AppShell (keeps this file JSX-free). */
  icon: string;
}
export interface NavGroup {
  key: string;
  titleKey: string;
  items: NavItem[];
}

/**
 * Permission-driven, GROUPED navigation (v1 redesign). Three sections keep a long
 * flat list scannable; the eight admin config pages collapse into a single
 * "Cấu hình" hub entry (they live inside /admin/settings now, not the sidebar).
 * Hiding an item is UX only — the backend still enforces access via Guards + RLS.
 */
export function menuForRole(me: Me): NavGroup[] {
  const has = (cap: string): boolean => me.capabilities.includes(cap);

  // The ticket workspace is ONE sidebar entry; its views (Của tôi / Pool / Chờ xử
  // lý / Thư rác) live in an in-page tab bar (TicketsTabBar), not the sidebar.
  const work: NavItem[] = [
    { key: 'inbox', path: '/inbox', labelKey: 'menu.inbox', icon: 'inbox' },
  ];
  const reports: NavItem[] = [
    { key: 'reports', path: '/reports', labelKey: 'menu.reports', icon: 'chart' },
    { key: 'audit', path: '/audit', labelKey: 'menu.audit', icon: 'audit' },
  ];
  const settings: NavItem = { key: 'settings', path: '/admin/settings', labelKey: 'menu.settings', icon: 'setting' };
  const roles: NavItem = { key: 'roles', path: '/admin/roles', labelKey: 'menu.roles', icon: 'safety' };

  const groups: NavGroup[] = [{ key: 'work', titleKey: 'menu.group.work', items: work }];

  // Đơn 13: a member gets the Reports entry too (self report, pinned by the BE)
  // — but not the audit log, which stays TL/Admin/SSA.
  groups.push({
    key: 'reports',
    titleKey: 'menu.group.reports',
    items: me.role === 'member' ? reports.filter((i) => i.key === 'reports') : reports,
  });

  // Admin section is CAPABILITY-driven (not role-hardcoded) so the SSA's /admin/roles
  // matrix actually drives the sidebar: toggling config.manage / role.edit_capabilities
  // for a role shows/hides these on that role's next /me (≤60s). Hiding is UX only —
  // Guards + RLS still enforce access on the backend.
  const adminItems: NavItem[] = [];
  if (has('config.manage') || has('config.manage_all')) adminItems.push(settings);
  if (has('role.edit_capabilities')) adminItems.push(roles);
  if (adminItems.length > 0) {
    groups.push({ key: 'admin', titleKey: 'menu.group.admin', items: adminItems });
  }
  return groups;
}

/** Ticket-workspace child routes light up the Inbox entry (their views live in the
 *  in-page tab bar, not the sidebar). */
const INBOX_CHILD_PREFIXES = ['/tickets', '/my-tickets', '/pool', '/pending', '/junk', '/search'];

/**
 * Which sidebar entry to highlight for a pathname. Exact-pathname matching loses the
 * highlight on every child route (/tickets/:id, /admin/groups, …), so resolve by
 * prefix: ticket-workspace children → Inbox, config children → the Settings hub,
 * otherwise the longest matching item path.
 */
export function activeMenuKey(pathname: string, groups: NavGroup[]): string | undefined {
  const paths = groups.flatMap((g) => g.items.map((i) => i.path));
  const starts = (p: string, prefix: string) => p === prefix || p.startsWith(prefix + '/');
  if (INBOX_CHILD_PREFIXES.some((p) => starts(pathname, p)) && paths.includes('/inbox')) {
    return '/inbox';
  }
  const match = paths.filter((p) => starts(pathname, p)).sort((a, b) => b.length - a.length)[0];
  if (match) return match;
  // Any other /admin/* page (users, groups, categories, …) is a child of the hub.
  if (starts(pathname, '/admin') && paths.includes('/admin/settings')) return '/admin/settings';
  return undefined;
}
