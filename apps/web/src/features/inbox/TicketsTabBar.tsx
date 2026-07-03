import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Segmented, Badge } from 'antd';
import { useMe } from '../../lib/auth';
import { useTicketCounts } from '../../lib/tickets';
import { palette } from '../../theme';

/**
 * In-page view switcher for the ticket workspace (v1 redesign). The five ticket
 * lists — Inbox / My tickets / Pool / Pending / Junk — used to be five sidebar
 * items; now they are one sidebar entry ("Hộp thư") + this tab bar. Each tab is a
 * route (no logic change to the underlying pages), so deep links keep working.
 */
export function TicketsTabBar({ activeTotal, mb = 16 }: { activeTotal?: number; mb?: number }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const { data: counts } = useTicketCounts();
  const loc = useLocation();
  const nav = useNavigate();

  // "Chờ xử lý" (snoozed) is a secondary view → it sits at the END of the bar, after
  // the everyday lists and Thư rác.
  const tabs = [
    { value: '/inbox', label: t('menu.inbox') },
    { value: '/my-tickets', label: t('menu.myTickets') },
    { value: '/pool', label: t('menu.pool') },
  ];
  if (me?.role === 'admin' || me?.role === 'ssa') {
    tabs.push({ value: '/junk', label: t('menu.junk') });
  }
  tabs.push({ value: '/pending', label: t('menu.pending') });

  const active = tabs.find((x) => x.value === loc.pathname)?.value ?? '/inbox';

  // Every list-tab carries an always-visible "folder count" (like an email sidebar) so a
  // user on /inbox still sees what's waiting in My / Pool / Pending. Inbox shows its total
  // only while active (its "all" count is large + filter-dependent); Junk has no badge.
  const badgeFor = (value: string): number | undefined => {
    if (value === '/my-tickets') return counts?.mine;
    if (value === '/pool') return counts?.pool;
    if (value === '/pending') return counts?.pending;
    if (value === '/inbox') return value === active ? activeTotal : undefined;
    return undefined;
  };

  const options = tabs.map((tab) => {
    const c = badgeFor(tab.value);
    if (c === undefined || c <= 0) return tab;
    // Active tab → solid navy; idle tabs → muted slate so they read as quiet counters.
    return {
      value: tab.value,
      label: (
        <span>
          {tab.label}{' '}
          <Badge
            count={c}
            overflowCount={9999}
            style={{ backgroundColor: tab.value === active ? palette.primary : '#8A97AB', marginInlineStart: 2 }}
          />
        </span>
      ),
    };
  });

  return (
    <Segmented
      options={options}
      value={active}
      onChange={(v) => nav(v as string)}
      style={{ marginBottom: mb }}
    />
  );
}
