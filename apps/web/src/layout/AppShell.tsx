import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Layout, Menu, Dropdown, Segmented, Button, Tag } from 'antd';
import { useMe, logout } from '../lib/auth';
import { menuForRole } from './menu';
import { setLanguage } from '../i18n';
import i18n from '../i18n';

const { Header, Sider, Content } = Layout;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { data: me } = useMe();
  if (!me) return null;

  const items = menuForRole(me).map((m) => ({ key: m.path, label: t(m.labelKey) }));

  const onLogout = async () => {
    await logout();
    await qc.invalidateQueries({ queryKey: ['me'] });
    navigate('/login');
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
