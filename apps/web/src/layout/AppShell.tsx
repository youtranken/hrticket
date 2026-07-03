import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Layout, Menu, Dropdown, Segmented, Button, Avatar, Select, Typography, App as AntApp } from 'antd';
import {
  InboxOutlined,
  FileTextOutlined,
  TeamOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  BarChartOutlined,
  AuditOutlined,
  SettingOutlined,
  SafetyOutlined,
  UserOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { useMe, logout, setServerLanguage } from '../lib/auth';
import { setActiveProject, getActiveProject } from '../lib/activeProject';
import { activeMenuKey, menuForRole } from './menu';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { GlobalSearch } from '../features/search/GlobalSearch';
import { ProfileModal } from '../features/profile/ProfilePage';
import { AvailabilityMenu } from '../features/profile/AvailabilityMenu';
import { setLanguage } from '../i18n';
import i18n from '../i18n';
import { palette } from '../theme';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const ICONS: Record<string, React.ReactNode> = {
  inbox: <InboxOutlined />,
  file: <FileTextOutlined />,
  team: <TeamOutlined />,
  clock: <ClockCircleOutlined />,
  delete: <DeleteOutlined />,
  chart: <BarChartOutlined />,
  audit: <AuditOutlined />,
  setting: <SettingOutlined />,
  safety: <SafetyOutlined />,
};

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((s) => s[0])
    .slice(-2)
    .join('')
    .toUpperCase();
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { data: me } = useMe();

  // The sidebar is a permanent icons-only rail (no expand/collapse toggle): it keeps
  // the worklist full-width everywhere and AntD surfaces each item's label as a hover
  // tooltip in collapsed inline mode, so nothing is lost. Applies to every role.
  const collapsed = true;
  const [profileOpen, setProfileOpen] = useState(false);

  // Apply the account's saved language on login from any machine (Story 11.2 AC3).
  useEffect(() => {
    if (me?.language && me.language !== i18n.language) {
      setLanguage(me.language as 'vi' | 'en');
    }
  }, [me?.language]);

  // SSA: pin an active project on first login (none stored yet) so the X-Project header
  // is always sent and /inbox is scoped to one project — matching the header switcher.
  useEffect(() => {
    if (me?.role === 'ssa' && me.projectKey && !getActiveProject()) {
      setActiveProject(me.projectKey);
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['tickets-poll'] });
    }
  }, [me?.role, me?.projectKey, qc]);

  if (!me) return null;

  const onChangeLanguage = (v: 'vi' | 'en') => {
    setLanguage(v); // immediate, no reload (i18next)
    void setServerLanguage(v).catch(() => undefined); // persist to the account
  };

  // Grouped menu (v1 redesign) — sections + icons; admin config lives in the hub.
  // When collapsed we flatten to a plain icon list (no group titles) so the rail is
  // icons-only; AntD shows each item's label as a hover tooltip in collapsed mode.
  const navGroups = menuForRole(me);
  const menuItems = collapsed
    ? navGroups.flatMap((g) =>
        g.items.map((it) => ({ key: it.path, icon: ICONS[it.icon], label: t(it.labelKey) })),
      )
    : navGroups.map((g) => ({
        type: 'group' as const,
        key: g.key,
        label: t(g.titleKey),
        children: g.items.map((it) => ({
          key: it.path,
          icon: ICONS[it.icon],
          label: t(it.labelKey),
        })),
      }));
  // Prefix-resolved highlight — child routes (/tickets/:id, /admin/groups, …) keep
  // their parent entry lit instead of dropping the selection entirely.
  const selectedKey = activeMenuKey(location.pathname, navGroups);

  const onLogout = async () => {
    await logout();
    // Hard redirect to a CLEAN /login (no ?returnUrl). A fresh login must land on the
    // default inbox — NOT resume the page we were on (which may be admin-only, so a
    // member re-logging in would be bounced). A full reload also wins the race against
    // the route guard, which would otherwise stamp the current path into ?returnUrl the
    // moment the ['me'] cache flips to null.
    window.location.assign('/login');
  };
  // Guard against a mis-click logging the user out of an internal tool.
  const confirmLogout = () => {
    modal.confirm({
      title: t('logout.confirm'),
      okText: t('common.logout'),
      okButtonProps: { danger: true },
      onOk: onLogout,
    });
  };

  // SSA-only: switch the active project. Persist it (→ X-Project header) and refetch
  // everything for the new project. Stay on the current admin/report page (better UX) —
  // only a ticket detail must be left, since that ticket belongs to the old project.
  const onSwitchProject = async (key: string) => {
    const target = me.projects.find((p) => p.key === key);
    setActiveProject(key);
    await qc.invalidateQueries();
    if (location.pathname.startsWith('/tickets/')) navigate('/inbox');
    message.success(t('header.projectSwitched', { name: target?.name ?? key }));
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        breakpoint="lg"
        collapsedWidth={64}
        width={232}
        collapsed={collapsed}
        // Permanent rail — no trigger, no toggle (hover a row to see its label tooltip).
        trigger={null}
      >
        <div style={{ padding: collapsed ? '14px 8px 6px' : '14px 14px 6px' }}>
          <div
            style={{
              background: '#fff',
              borderRadius: 10,
              padding: collapsed ? '8px' : '10px 12px',
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <img
              src="/logo.png"
              alt="Phú Mỹ Hưng"
              style={{ height: collapsed ? 28 : 40, maxWidth: '100%', objectFit: 'contain' }}
            />
          </div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          items={menuItems}
          onClick={(e) => navigate(e.key)}
          style={{ background: 'transparent', borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            borderBottom: '1px solid #EAEDF3',
          }}
        >
          {/* Global ticket search (Story 10.2) — left; utilities sit right. */}
          <div style={{ marginRight: 'auto', maxWidth: 420, width: '100%' }}>
            <GlobalSearch />
          </div>
          {me.projects.length > 1 && (
            <Select
              size="small"
              value={me.projectKey}
              style={{ minWidth: 150 }}
              onChange={onSwitchProject}
              options={me.projects.map((p) => ({ label: p.name, value: p.key }))}
              aria-label={t('header.project')}
            />
          )}
          {/* Availability chip removed from the header (đơn 10) — but the away window
              still steers auto-assign, so the CONTROL moved into the profile dropdown
              below (review #6: without it, an away flag could never be cleared). */}
          <NotificationBell />
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            dropdownRender={() => (
              <div
                style={{
                  background: '#fff',
                  borderRadius: 12,
                  boxShadow: '0 6px 24px rgba(15,27,51,0.12)',
                  padding: 14,
                  width: 248,
                }}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                  <Avatar style={{ background: palette.primary }}>{initialsOf(me.user.name)}</Avatar>
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{me.user.name}</div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {me.role.toUpperCase()} · {me.user.email}
                    </Text>
                  </div>
                </div>
                <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                  {t('header.language')}
                </Text>
                <Segmented
                  block
                  size="small"
                  value={i18n.language === 'en' ? 'en' : 'vi'}
                  options={[
                    { label: 'Tiếng Việt', value: 'vi' },
                    { label: 'English', value: 'en' },
                  ]}
                  onChange={(v) => onChangeLanguage(v as 'vi' | 'en')}
                  style={{ marginBottom: 10 }}
                />
                <Button
                  block
                  type="text"
                  icon={<UserOutlined />}
                  style={{ justifyContent: 'flex-start' }}
                  onClick={() => setProfileOpen(true)}
                >
                  {t('menu.profile')}
                </Button>
                {/* Away window control (đơn 10 moved it off the header, not out of the app). */}
                <div style={{ padding: '2px 4px' }}>
                  <AvailabilityMenu />
                </div>
                <Button
                  block
                  type="text"
                  danger
                  icon={<LogoutOutlined />}
                  style={{ justifyContent: 'flex-start' }}
                  onClick={confirmLogout}
                >
                  {t('common.logout')}
                </Button>
              </div>
            )}
          >
            <Button type="text" style={{ height: 40, paddingInline: 8 }}>
              <Avatar size={28} style={{ background: palette.primary }}>
                {initialsOf(me.user.name)}
              </Avatar>
              <span style={{ marginInlineStart: 8 }}>{me.user.name}</span>
            </Button>
          </Dropdown>
        </Header>
        <Content style={{ margin: 20 }}>{children}</Content>
      </Layout>
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </Layout>
  );
}
