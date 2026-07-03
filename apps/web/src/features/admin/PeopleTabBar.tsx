import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Segmented } from 'antd';
import { useMe } from '../../lib/auth';

/**
 * Unites the People & Permissions pages — Users / Groups / Roles — into one tabbed
 * area (v1 redesign). Each tab is a route (no logic change to the underlying pages),
 * so deep links + e2e keep working. Roles is SSA-only.
 */
export function PeopleTabBar() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const loc = useLocation();
  const nav = useNavigate();

  const tabs = [
    { value: '/admin/users', label: t('menu.users') },
    { value: '/admin/groups', label: t('groups.nav') },
  ];
  if (me?.role === 'ssa') tabs.push({ value: '/admin/roles', label: t('menu.roles') });

  const active = tabs.find((x) => x.value === loc.pathname)?.value ?? '/admin/users';

  return (
    <Segmented
      options={tabs}
      value={active}
      onChange={(v) => nav(v as string)}
      style={{ marginBottom: 16 }}
    />
  );
}
