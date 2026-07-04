import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { PeopleTabBar } from './PeopleTabBar';
import {
  Card,
  Table,
  Button,
  Tag,
  Drawer,
  Input,
  Select,
  Space,
  Switch,
  Dropdown,
  Modal,
  Typography,
  App as AntApp,
} from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import type { ModalStaticFunctions } from 'antd/es/modal/confirm';
import { api } from '../../lib/apiClient';
import { useMe } from '../../lib/auth';
import {
  useAdminUsers,
  useAdminCategories,
  createUser,
  setUserRole,
  setUserDisabled,
  updateUser,
  moveUserProject,
  type AdminUser,
  type AssignableRole,
} from '../../lib/admin';
import { fmtDateTime } from '../../lib/datetime';

const { Text } = Typography;
const ROLE_OPTIONS: AssignableRole[] = ['admin', 'team_lead', 'member'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Show the one-time temp password. MUST use the `modal` instance from App.useApp() —
 *  the static `Modal.info` does not render under the App provider in React 19
 *  (CLAUDE.md pitfall: the dialog silently never appears). */
function showTempPassword(
  modal: Omit<ModalStaticFunctions, 'warn'>,
  tempPassword: string,
  title: string,
  warn: string,
) {
  modal.info({
    title,
    content: (
      <>
        <Typography.Text copyable>{tempPassword}</Typography.Text>
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="warning">{warn}</Typography.Text>
        </div>
      </>
    ),
  });
}

/** Full user admin (Story 9.2, FR89): create / disable / role assignment + search. */
export function AdminUsersPage() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: users = [], isLoading, refetch } = useAdminUsers();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [moving, setMoving] = useState<AdminUser | null>(null);

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

  // Confirm before applying a role change (avoid an accidental inline click).
  const confirmRole = (u: AdminUser, role: AssignableRole) => {
    if (role === u.role) return;
    modal.confirm({
      title: t('users.confirmRole', { role: t(`role.${role}`) }),
      onOk: () => changeRole(u, role),
    });
  };

  // Confirm before flipping the active/disabled switch.
  const confirmToggle = (u: AdminUser) => {
    modal.confirm({
      title: u.disabled ? t('users.confirmEnable') : t('users.confirmDisable'),
      okText: u.disabled ? t('users.enable') : t('users.disable'),
      okButtonProps: u.disabled ? undefined : { danger: true },
      onOk: () => toggleDisabled(u),
    });
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

  // Both actions are security-sensitive: always confirm first, and surface API
  // failures (a silent throw here used to leave the admin with no feedback at all).
  const resetPassword = (u: AdminUser) => {
    modal.confirm({
      title: t('users.confirmResetPassword', { name: u.name }),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const res = await api<{ tempPassword: string }>(`/admin/users/${u.id}/reset-password`, {
            method: 'POST',
          });
          showTempPassword(modal, res.tempPassword, t('users.tempPassword'), t('users.tempPasswordWarn'));
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  const removeOtp = (u: AdminUser) => {
    modal.confirm({
      title: t('users.confirmRemoveOtp', { name: u.name }),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api(`/admin/users/${u.id}/remove-otp`, { method: 'POST' });
          message.success(t('users.otpRemoved'));
          refresh();
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  return (
    <>
      <PeopleTabBar />
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
        loading={isLoading}
        dataSource={filtered}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: t('common.email'), dataIndex: 'email' },
          { title: t('users.name'), dataIndex: 'name' },
          {
            title: t('users.project'),
            dataIndex: 'projectId',
            width: 120,
            // SSA sees both projects → let them filter; Admin sees only their own.
            filters:
              me?.role === 'ssa'
                ? (me?.projects ?? []).map((p) => ({ text: p.name, value: p.id }))
                : undefined,
            onFilter: (val, u: AdminUser) => u.projectId === (val as number),
            render: (pid: number | null) => {
              const p = me?.projects.find((x) => x.id === pid);
              return p ? <Tag color="geekblue">{p.name}</Tag> : <Tag>—</Tag>;
            },
          },
          {
            title: t('users.role'),
            width: 150,
            dataIndex: 'role',
            filters: (['ssa', 'admin', 'team_lead', 'member'] as const).map((r) => ({
              text: t(`role.${r}`),
              value: r,
            })),
            onFilter: (val, u: AdminUser) => u.role === val,
            render: (_: unknown, u: AdminUser) =>
              canManage(u) ? (
                <Select<AssignableRole>
                  size="small"
                  value={u.role as AssignableRole}
                  style={{ width: 130 }}
                  options={assignable.map((r) => ({ value: r, label: t(`role.${r}`) }))}
                  onChange={(r) => confirmRole(u, r)}
                />
              ) : (
                <Tag>{t(`role.${u.role}`)}</Tag>
              ),
          },
          {
            title: t('users.twoFa'),
            dataIndex: 'otpEnabled',
            width: 110,
            filters: [
              { text: t('users.twoFaOn'), value: true },
              { text: t('users.twoFaOff'), value: false },
            ],
            onFilter: (val, u: AdminUser) => !!u.otpEnabled === val,
            render: (_: unknown, u: AdminUser) =>
              u.otpEnabled ? (
                <Tag color="green">{t('users.twoFaOn')}</Tag>
              ) : (
                <Tag>{t('users.twoFaOff')}</Tag>
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
            title: t('users.lastLogin'),
            width: 160,
            render: (_: unknown, u: AdminUser) =>
              u.lastLoginAt ? (
                fmtDateTime(u.lastLoginAt)
              ) : (
                <Tag>{t('users.neverLoggedIn')}</Tag>
              ),
          },
          {
            title: t('users.status'),
            dataIndex: 'disabled',
            width: 140,
            filters: [
              { text: t('users.activeTag'), value: false },
              { text: t('users.disabledTag'), value: true },
            ],
            onFilter: (val, u: AdminUser) => u.disabled === val,
            // A clear Active ⇄ Disabled toggle (with confirm) instead of a "lock" button.
            render: (_: unknown, u: AdminUser) =>
              canManage(u) ? (
                <Switch
                  checked={!u.disabled}
                  checkedChildren={t('users.activeTag')}
                  unCheckedChildren={t('users.disabledTag')}
                  onChange={() => confirmToggle(u)}
                />
              ) : u.disabled ? (
                <Tag color="red">{t('users.disabledTag')}</Tag>
              ) : (
                <Tag color="green">{t('users.activeTag')}</Tag>
              ),
          },
          {
            title: '',
            width: 56,
            // UX gate only (BE re-enforces): rows this actor cannot touch get no
            // action menu at all — offering Reset/Edit that will just 403 is noise.
            render: (_: unknown, u: AdminUser) =>
              !canManage(u) ? null : (
              <Dropdown
                menu={{
                  items: [
                    { key: 'edit', label: t('users.edit'), onClick: () => setEditing(u) },
                    // Cross-project relocation is an SSA-only authority (never on yourself
                    // or another SSA). The server re-enforces this.
                    ...(isSsa && u.role !== 'ssa' && u.id !== me?.user.id
                      ? [{ key: 'move', label: t('users.moveProject'), onClick: () => setMoving(u) }]
                      : []),
                    { key: 'reset', label: t('users.reset'), onClick: () => resetPassword(u) },
                    { key: 'otp', label: t('users.removeOtp'), onClick: () => removeOtp(u) },
                  ],
                }}
              >
                <Button size="small" type="text" icon={<MoreOutlined />} />
              </Dropdown>
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
      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {moving && (
        <MoveProjectModal
          user={moving}
          onClose={() => setMoving(null)}
          onMoved={() => {
            setMoving(null);
            refresh();
          }}
        />
      )}
      </Card>
    </>
  );
}

/** Edit a user's email + name (Story 9.2). */
function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [email, setEmail] = useState(user.email);
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateUser(user.id, { email, name });
      message.success(t('common.saved'));
      onSaved();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={t('users.edit')}
      onCancel={onClose}
      onOk={save}
      okButtonProps={{ loading: saving, disabled: !EMAIL_RE.test(email.trim()) || !name.trim() }}
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
      </Space>
    </Modal>
  );
}

/** Move a user to another project (SSA only, Story 9.2 extension). */
function MoveProjectModal({
  user,
  onClose,
  onMoved,
}: {
  user: AdminUser;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { data: me } = useMe();
  const [target, setTarget] = useState<number>();
  const [saving, setSaving] = useState(false);
  const currentName = me?.projects.find((p) => p.id === user.projectId)?.name ?? '—';
  const options = (me?.projects ?? []).filter((p) => p.id !== user.projectId);

  const move = async () => {
    if (!target) return;
    setSaving(true);
    try {
      await moveUserProject(user.id, target);
      message.success(t('users.moved'));
      onMoved();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={t('users.moveProject')}
      onCancel={onClose}
      onOk={move}
      okButtonProps={{ loading: saving, disabled: !target }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Text>
          {t('users.moveFrom')}: <Tag color="geekblue">{currentName}</Tag>
        </Text>
        <div>
          <Text>{t('users.moveTo')}</Text>
          <Select<number>
            style={{ width: '100%', marginTop: 4 }}
            value={target}
            onChange={setTarget}
            placeholder={t('users.moveTo')}
            options={options.map((p) => ({ value: p.id, label: p.name }))}
          />
        </div>
        <Text type="secondary">{t('users.moveWarn')}</Text>
      </Space>
    </Modal>
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
  const { data: me } = useMe();
  const { data: cats = [] } = useAdminCategories();
  const isSsa = me?.role === 'ssa';
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const [projectId, setProjectId] = useState<number | undefined>(me?.projectId ?? undefined);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  // Categories are loaded for the SSA's ACTIVE project; if they target another
  // project, hide the group picker (those categories don't belong to it).
  const showGroups = !isSsa || projectId === undefined || projectId === me?.projectId;

  const save = async () => {
    setSaving(true);
    try {
      const res = await createUser({
        email,
        name,
        role,
        categoryIds: showGroups ? categoryIds : [],
        projectId: isSsa ? projectId : undefined,
      });
      showTempPassword(modal, res.tempPassword, t('users.tempPassword'), t('users.tempPasswordWarn'));
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
        <Button
          type="primary"
          loading={saving}
          onClick={save}
          disabled={!EMAIL_RE.test(email.trim()) || !name || (isSsa && !projectId)}
        >
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
        {isSsa && (
          <div>
            <Text>{t('users.project')}</Text>
            <Select<number>
              style={{ width: '100%', marginTop: 4 }}
              value={projectId}
              onChange={setProjectId}
              placeholder={t('users.project')}
              options={(me?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
        )}
        <div>
          <Text>{t('users.role')}</Text>
          <Select<AssignableRole>
            style={{ width: '100%', marginTop: 4 }}
            value={role}
            onChange={setRole}
            options={assignable.map((r) => ({ value: r, label: t(`role.${r}`) }))}
          />
        </div>
        {showGroups ? (
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
        ) : (
          <Text type="secondary">{t('users.groupsOtherProject')}</Text>
        )}
        <Text type="secondary">{t('users.tempHint')}</Text>
      </Space>
    </Drawer>
  );
}
