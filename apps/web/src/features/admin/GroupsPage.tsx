import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  Card,
  Table,
  Tabs,
  Tag,
  Transfer,
  Select,
  Checkbox,
  Button,
  Space,
  Alert,
  Typography,
  App as AntApp,
} from 'antd';
import {
  useGroups,
  useGroupMembers,
  setGroupMembers,
  useUserGroups,
  setUserGroups,
  type AdminGroup,
} from '../../lib/groups';
import { useAdminUsers } from '../../lib/admin';

const { Text } = Typography;

/** Story 9.1 (FR57/FR58/FR61) — assign users to category groups. Two directions:
 *  by group (transfer list) and by user (group checklist). RLS makes every change
 *  effective on the user's next request; the menu/role gate is UX only. */
export function GroupsPage() {
  const { t } = useTranslation();
  return (
    <Card title={t('groups.title')}>
      <Tabs
        items={[
          { key: 'byGroup', label: t('groups.byGroup'), children: <ByGroupTab /> },
          { key: 'byUser', label: t('groups.byUser'), children: <ByUserTab /> },
        ]}
      />
    </Card>
  );
}

/** A category that is sensitive shows the 🛡 badge (CONVENTIONS §9). */
function GroupName({ g }: { g: AdminGroup }) {
  const { t } = useTranslation();
  return (
    <Space size={4}>
      <span>{g.nameVi}</span>
      {g.isSensitive && <Tag color="red">🛡 {t('groups.sensitive')}</Tag>}
      {g.isSystem && <Tag color="gold">{t('groups.system')}</Tag>}
    </Space>
  );
}

function ByGroupTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { data: groups = [], isLoading } = useGroups();
  const [selected, setSelected] = useState<number | null>(null);
  // Raw query data (no `= []` default): react-query keeps a STABLE reference until the
  // data changes, so the effect below only re-seeds when membership actually loads —
  // a defaulted `[]` would be a fresh array every render → infinite setState loop.
  const { data: members } = useGroupMembers(selected);
  const memberList = members ?? [];
  const [targetKeys, setTargetKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Seed the transfer's right column from the loaded membership.
  useEffect(() => {
    if (members) setTargetKeys(members.filter((m) => m.inGroup).map((m) => m.id));
  }, [members]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'groups'] });

  const save = async () => {
    if (selected === null) return;
    setSaving(true);
    try {
      await setGroupMembers(selected, targetKeys);
      message.success(t('groups.saved'));
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <Table<AdminGroup>
        rowKey="categoryId"
        style={{ minWidth: 360, flex: '1 1 360px' }}
        loading={isLoading}
        dataSource={groups}
        pagination={false}
        rowClassName={(g) => (g.categoryId === selected ? 'ant-table-row-selected' : '')}
        onRow={(g) => ({ onClick: () => setSelected(g.categoryId), style: { cursor: 'pointer' } })}
        columns={[
          { title: t('groups.group'), render: (_: unknown, g: AdminGroup) => <GroupName g={g} /> },
          {
            title: t('groups.members'),
            dataIndex: 'memberCount',
            width: 150,
            render: (n: number) =>
              n === 0 ? (
                <Tag color="warning">{t('groups.zeroMembers')}</Tag>
              ) : (
                <Text>{t('groups.memberCount', { n })}</Text>
              ),
          },
        ]}
      />
      <div style={{ flex: '2 1 480px', minWidth: 480 }}>
        {selected === null ? (
          <Alert type="info" showIcon message={t('groups.pickGroupHint')} />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Transfer<{ key: string; title: string; description: string; disabled: boolean }>
              dataSource={memberList.map((m) => ({
                key: m.id,
                title: m.name,
                description: m.email,
                disabled: false,
              }))}
              showSearch
              filterOption={(input, item) =>
                (item.title + item.description).toLowerCase().includes(input.toLowerCase())
              }
              targetKeys={targetKeys}
              onChange={(keys) => setTargetKeys(keys as string[])}
              render={(item) => `${item.title} (${item.description})`}
              titles={[t('groups.available'), t('groups.inGroup')]}
              listStyle={{ width: 280, height: 380 }}
            />
            <Button type="primary" loading={saving} onClick={save}>
              {t('common.save')}
            </Button>
          </Space>
        )}
      </div>
    </div>
  );
}

function ByUserTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { data: users = [] } = useAdminUsers();
  const { data: groups = [] } = useGroups();
  const [userId, setUserId] = useState<string | null>(null);
  // Raw query data (stable ref) so the effect only re-seeds on real change (see ByGroupTab).
  const { data: current } = useUserGroups(userId);
  const [checked, setChecked] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (current) setChecked(current);
  }, [current]);

  const options = useMemo(
    () => groups.map((g) => ({ label: g.nameVi + (g.isSensitive ? ' 🛡' : ''), value: g.categoryId })),
    [groups],
  );

  const save = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      await setUserGroups(userId, checked);
      message.success(t('groups.saved'));
      qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%', maxWidth: 560 }} size="middle">
      <div>
        <Text>{t('groups.pickUser')}</Text>
        <Select
          showSearch
          style={{ width: '100%', marginTop: 4 }}
          value={userId}
          onChange={setUserId}
          placeholder={t('groups.pickUser')}
          optionFilterProp="label"
          options={users
            .filter((u) => u.role !== 'ssa')
            .map((u) => ({
              value: u.id,
              label: `${u.name} (${u.email})${u.disabled ? ' — ' + t('groups.disabled') : ''}`,
            }))}
        />
      </div>
      {userId && (
        <>
          <Checkbox.Group
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            options={options}
            value={checked}
            onChange={(v) => setChecked(v as number[])}
          />
          <Button type="primary" loading={saving} onClick={save}>
            {t('common.save')}
          </Button>
        </>
      )}
    </Space>
  );
}
