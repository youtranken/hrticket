import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Layout, Menu, Dropdown, Segmented, Button, Tag, Select, App as AntApp } from 'antd';
import { useMe, logout } from '../lib/auth';
import { setActiveProject } from '../lib/activeProject';
import { menuForRole } from './menu';
import { AvailabilityMenu } from '../features/profile/AvailabilityMenu';
import { setLanguage } from '../i18n';
import i18n from '../i18n';

const { Header, Sider, Content } = Layout;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { data: me } = useMe();
  if (!me) return null;

  const items = menuForRole(me).map((m) => ({ key: m.path, label: t(m.labelKey) }));

  const onLogout = async () => {
    await logout();
    await qc.invalidateQueries({ queryKey: ['me'] });
    navigate('/login');
  };

  // SSA-only: switch the active project. Persist it (→ X-Project header), refetch
  // everything for the new project, land on Inbox, and confirm with a toast
  // (Story 1.8 AC3 / party-mode S4: don't keep a project-A route after switching).
  const onSwitchProject = async (key: string) => {
    const target = me.projects.find((p) => p.key === key);
    setActiveProject(key);
    await qc.invalidateQueries(); // all project-scoped data is now stale
    navigate('/inbox');
    message.success(t('header.projectSwitched', { name: target?.name ?? key }));
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0">
        <div style={{ color: '#fff', padding: 16, fontWeight: 600 }}>HRIS Ticket</div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={items}
          onClick={(e) => navigate(e.key)}
        />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          {me.projects.length > 1 && (
            <Select
              size="small"
              value={me.projectKey}
              style={{ minWidth: 140 }}
              onChange={onSwitchProject}
              options={me.projects.map((p) => ({ label: p.name, value: p.key }))}
              aria-label={t('header.project')}
            />
          )}
          <AvailabilityMenu />
          <Tag color="blue">{me.role.toUpperCase()}</Tag>
          <Segmented
            size="small"
            value={i18n.language === 'en' ? 'en' : 'vi'}
            options={[
              { label: 'VI', value: 'vi' },
              { label: 'EN', value: 'en' },
            ]}
            onChange={(v) => setLanguage(v as 'vi' | 'en')}
          />
          <Dropdown
            menu={{
              items: [
                { key: 'profile', label: t('menu.profile'), onClick: () => navigate('/profile') },
                { key: 'logout', label: t('common.logout'), onClick: onLogout },
              ],
            }}
          >
            <Button type="text">{me.user.name}</Button>
          </Dropdown>
        </Header>
        <Content style={{ margin: 16 }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
