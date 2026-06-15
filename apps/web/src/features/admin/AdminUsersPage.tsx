import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  Card,
  Table,
  Button,
  Tag,
  Drawer,
  Input,
  Select,
  Space,
  Popconfirm,
  Typography,
  App as AntApp,
} from 'antd';
import type { ModalStaticFunctions } from 'antd/es/modal/confirm';
import { api } from '../../lib/apiClient';
import { useMe } from '../../lib/auth';
import {
  useAdminUsers,
  useAdminCategories,
  createUser,
  setUserRole,
  setUserDisabled,
  type AdminUser,
  type AssignableRole,
} from '../../lib/admin';

const { Text } = Typography;
const ROLE_OPTIONS: AssignableRole[] = ['admin', 'team_lead', 'member'];

/** Show the one-time temp password. MUST use the `modal` instance from App.useApp() —
 *  the static `Modal.info` does not render under the App provider in React 19
 *  (CLAUDE.md pitfall: the dialog silently never appears). */
function showTempPassword(modal: Omit<ModalStaticFunctions, 'warn'>, tempPassword: string, title: string) {
  modal.info({ title, content: <Typography.Text copyable>{tempPassword}</Typography.Text> });
}

/** Full user admin (Story 9.2, FR89): create / disable / role assignment + search. */
export function AdminUsersPage() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: users = [], refetch } = useAdminUsers();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const isSsa = me?.role === 'ssa';
  const assignable: AssignableRole[] = isSsa ? ROLE_OPTIONS : ['team_lead', 'member'];

  /** UX gate (BE re-enforces): who this actor may touch. */
  const canManage = (u: AdminUser): boolean => {
    if (!me) return false;
    if (u.id === me.user.id) return false; // never your own role/disabled
    if (isSsa) return u.role !== 'ssa';
    return u.role !== 'admin' && u.role !== 'ssa' && u.projectId === me.projectId;
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return users;
    return users.filter(
      (u) => u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle),
    );
  }, [users, q]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    refetch();
  };

  const changeRole = async (u: AdminUser, role: AssignableRole) => {
    try {
      await setUserRole(u.id, role);
      message.success(t('users.roleChanged'));
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const toggleDisabled = async (u: AdminUser) => {
    try {
      await setUserDisabled(u.id, !u.disabled);
      message.success(u.disabled ? t('users.enabled') : t('users.disabledOk'));
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const resetPassword = async (u: AdminUser) => {
    const res = await api<{ tempPassword: string }>(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
    showTempPassword(modal, res.tempPassword, t('users.tempPassword'));
  };

  const removeOtp = async (u: AdminUser) => {
    await api(`/admin/users/${u.id}/remove-otp`, { method: 'POST' });
    message.success(t('users.otpRemoved'));
  };

  return (
    <Card title={t('menu.users')}>
      <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
        <Input.Search
          allowClear
          placeholder={t('users.search')}
          style={{ width: 280 }}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="primary" onClick={() => setCreating(true)}>
          {t('users.create')}
        </Button>
      </Space>
      <Table<AdminUser>
        rowKey="id"
        dataSource={filtered}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: t('common.email'), dataIndex: 'email' },
          { title: t('users.name'), dataIndex: 'name' },
          {
            title: t('users.role'),
            width: 150,
            render: (_: unknown, u: AdminUser) =>
              canManage(u) ? (
                <Select<AssignableRole>
                  size="small"
                  value={u.role as AssignableRole}
                  style={{ width: 130 }}
                  options={assignable.map((r) => ({ value: r, label: t(`role.${r}`) }))}
                  onChange={(r) => changeRole(u, r)}
                />
              ) : (
                <Tag>{t(`role.${u.role}`)}</Tag>
              ),
          },
          {
            title: t('users.groups'),
            render: (_: unknown, u: AdminUser) => (
              <Space size={4} wrap>
                {(u.groups ?? []).map((g) => (
                  <Tag key={g.categoryId}>{g.nameVi}</Tag>
                ))}
              </Space>
            ),
          },
          {
            title: t('users.availability'),
            width: 150,
            render: (_: unknown, u: AdminUser) =>
              u.awayFrom ? (
                <Text type="secondary">
                  {u.awayFrom} → {u.awayTo}
                </Text>
              ) : (
                '—'
              ),
          },
          {
            title: t('users.lastLogin'),
            width: 160,
            render: (_: unknown, u: AdminUser) =>
              u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('vi-VN') : '—',
          },
          {
            title: t('users.status'),
            dataIndex: 'disabled',
            width: 100,
            render: (d: boolean) =>
              d ? <Tag color="red">{t('users.disabledTag')}</Tag> : <Tag color="green">{t('users.activeTag')}</Tag>,
          },
          {
            title: '',
            render: (_: unknown, u: AdminUser) => (
              <Space>
                {canManage(u) && (
                  <Popconfirm
                    title={u.disabled ? t('users.confirmEnable') : t('users.confirmDisable')}
                    onConfirm={() => toggleDisabled(u)}
                  >
                    <Button size="small" danger={!u.disabled}>
                      {u.disabled ? t('users.enable') : t('users.disable')}
                    </Button>
                  </Popconfirm>
                )}
                <Button size="small" onClick={() => resetPassword(u)}>
                  {t('users.reset')}
                </Button>
                <Button size="small" onClick={() => removeOtp(u)}>
                  {t('users.removeOtp')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {creating && (
        <CreateUserDrawer
          assignable={assignable}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
    </Card>
  );
}

function CreateUserDrawer({
  assignable,
  onClose,
  onCreated,
}: {
  assignable: AssignableRole[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: cats = [] } = useAdminCategories();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const res = await createUser({ email, name, role, categoryIds });
      showTempPassword(modal, res.tempPassword, t('users.tempPassword'));
      message.success(t('users.created'));
      onCreated();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      width={420}
      title={t('users.create')}
      onClose={onClose}
      extra={
        <Button type="primary" loading={saving} onClick={save} disabled={!email || !name}>
          {t('common.save')}
        </Button>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Text>{t('common.email')}</Text>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Text>{t('users.name')}</Text>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Text>{t('users.role')}</Text>
          <Select<AssignableRole>
            style={{ width: '100%', marginTop: 4 }}
            value={role}
            onChange={setRole}
            options={assignable.map((r) => ({ value: r, label: t(`role.${r}`) }))}
          />
        </div>
        <div>
          <Text>{t('users.groups')}</Text>
          <Select
            mode="multiple"
            style={{ width: '100%', marginTop: 4 }}
            value={categoryIds}
            onChange={setCategoryIds}
            placeholder={t('groups.pickGroupHint')}
            optionFilterProp="label"
            options={cats.filter((c) => !c.isSystem).map((c) => ({ value: c.id, label: c.nameVi }))}
          />
        </div>
        <Text type="secondary">{t('users.tempHint')}</Text>
      </Space>
    </Drawer>
  );
}
