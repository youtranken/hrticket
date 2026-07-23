import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Card, Table, Switch, Button, Tooltip, Typography, Space, Popconfirm, App as AntApp } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { PeopleTabBar } from './PeopleTabBar';
import {
  useRoleCapabilities,
  setCapabilityCell,
  resetCapabilities,
  type CapRole,
  type CapabilityRow,
} from '../../lib/roleCapabilities';

const { Text } = Typography;

/** Story 9.4 (FR55) — SSA-only runtime editor for the role × capability matrix.
 *  Toggling a cell is enforced by CapabilityGuard on the role's very next API
 *  request (the write busts the guard cache); the user's MENU catches up on their
 *  next /me fetch. Locked cells (🔒) are the anti-self-lock guards and can't change. */
export function RolesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { data, isLoading } = useRoleCapabilities();
  const roles: CapRole[] = data?.roles ?? ['member', 'team_lead', 'admin', 'ssa'];

  const refresh = () => qc.invalidateQueries({ queryKey: ['ssa', 'role-capabilities'] });

  const toggle = async (role: CapRole, capability: string, allowed: boolean) => {
    try {
      await setCapabilityCell(role, capability, allowed);
      message.success(t('caps.saved'));
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // Each cell saves IMMEDIATELY — granting is easy to undo, but REVOKING blocks the
  // whole role at the API on their next request (mid-shift!), so it confirms first.
  const onCellChange = (role: CapRole, capability: string, allowed: boolean) => {
    if (allowed) {
      void toggle(role, capability, allowed);
      return;
    }
    modal.confirm({
      title: t('caps.confirmRevoke', { role: t(`role.${role}`) }),
      okButtonProps: { danger: true },
      onOk: () => toggle(role, capability, allowed),
    });
  };

  const reset = async () => {
    try {
      await resetCapabilities();
      message.success(t('caps.resetDone'));
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const roleColumns = roles.map((role) => ({
    title: t(`role.${role}`),
    key: role,
    width: 130,
    align: 'center' as const,
    render: (_: unknown, row: CapabilityRow) => {
      const cell = row.cells.find((c) => c.role === role);
      if (!cell) return '—';
      const sw = (
        <Switch
          checked={cell.allowed}
          disabled={cell.locked}
          onChange={(v) => onCellChange(role, row.capability, v)}
        />
      );
      // Two kinds of lock: SSA cells are locked ON (anti-self-lock), non-applicable
      // cells are locked OFF (the services hard-block that role — a dead toggle).
      return cell.locked ? (
        <Tooltip title={t(cell.allowed ? 'caps.locked' : 'caps.notApplicable')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LockOutlined style={{ color: '#8c8c8c' }} />
            {sw}
          </span>
        </Tooltip>
      ) : (
        sw
      );
    },
  }));

  return (
    <>
      <PeopleTabBar />
      <Card
        title={t('caps.title')}
        extra={
          <Popconfirm title={t('caps.confirmReset')} onConfirm={reset}>
            <Button>{t('caps.reset')}</Button>
          </Popconfirm>
        }
      >
      <Space wrap size={16} style={{ marginBottom: 12 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{t('caps.legend')}</Text>
        <Space size={6}>
          <Switch checked disabled size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>{t('caps.legendOn')}</Text>
        </Space>
        <Space size={6}>
          <Switch checked={false} disabled size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>{t('caps.legendOff')}</Text>
        </Space>
        <Space size={6}>
          <LockOutlined style={{ color: '#8c8c8c' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>{t('caps.legendLocked')}</Text>
        </Space>
      </Space>
      <Table<CapabilityRow>
        rowKey="capability"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        pagination={false}
        sticky
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('caps.capability'),
            key: 'capability',
            render: (_: unknown, row: CapabilityRow) => <Text strong>{t(`cap.${row.capability}`)}</Text>,
          },
          ...roleColumns,
        ]}
      />
      </Card>
    </>
  );
}
