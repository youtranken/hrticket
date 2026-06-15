import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Card, Table, Switch, Button, Tooltip, Typography, Space, Popconfirm, App as AntApp } from 'antd';
import {
  useRoleCapabilities,
  setCapabilityCell,
  resetCapabilities,
  type CapRole,
  type CapabilityRow,
} from '../../lib/roleCapabilities';

const { Text } = Typography;

/** Story 9.4 (FR55) — SSA-only runtime editor for the role × capability matrix.
 *  Toggling a cell takes effect on each user's next request (≤60s). Locked cells (🔒)
 *  are the anti-self-lock guards and can't be changed. */
export function RolesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
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
          onChange={(v) => toggle(role, row.capability, v)}
        />
      );
      return cell.locked ? (
        <Tooltip title={t('caps.locked')}>
          <span>
            🔒 {sw}
          </span>
        </Tooltip>
      ) : (
        sw
      );
    },
  }));

  return (
    <Card
      title={t('caps.title')}
      extra={
        <Popconfirm title={t('caps.confirmReset')} onConfirm={reset}>
          <Button>{t('caps.reset')}</Button>
        </Popconfirm>
      }
    >
      <Table<CapabilityRow>
        rowKey="capability"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        pagination={false}
        columns={[
          {
            title: t('caps.capability'),
            key: 'capability',
            render: (_: unknown, row: CapabilityRow) => (
              <Space direction="vertical" size={0}>
                <Text strong>{t(`cap.${row.capability}`)}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t(`cap.${row.capability}.desc`)}
                </Text>
              </Space>
            ),
          },
          ...roleColumns,
        ]}
      />
    </Card>
  );
}
