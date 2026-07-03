import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  PlusOutlined,
  SafetyCertificateOutlined,
  HolderOutlined,
  CloseOutlined,
  RightOutlined,
  LeftOutlined,
} from '@ant-design/icons';
import { PeopleTabBar } from './PeopleTabBar';
import {
  Card,
  Table,
  Tabs,
  Tag,
  Input,
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
import { useAdminUsers, useAdminCategories, putAutoAssign } from '../../lib/admin';
import { palette } from '../../theme';

const { Text } = Typography;

/** Story 9.1 (FR57/FR58/FR61) — assign users to category groups. Two directions:
 *  by group (transfer list) and by user (group checklist). RLS makes every change
 *  effective on the user's next request; the menu/role gate is UX only. */
export function GroupsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <PeopleTabBar />
      <Card
        title={t('groups.title')}
        // Quick jump to category management — groups ARE categories, so creating a new
        // one is a natural next step when assigning members (FR57).
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate('/admin/categories')}
          >
            {t('groups.addCategory')}
          </Button>
        }
      >
        <Tabs
          items={[
            { key: 'byGroup', label: t('groups.byGroup'), children: <ByGroupTab /> },
            { key: 'byUser', label: t('groups.byUser'), children: <ByUserTab /> },
          ]}
        />
      </Card>
    </>
  );
}

/** A category that is sensitive shows the 🛡 badge (CONVENTIONS §9). */
function GroupName({ g }: { g: AdminGroup }) {
  const { t } = useTranslation();
  return (
    <Space size={4}>
      <span>{g.nameVi}</span>
      {g.isSensitive && (
        <Tag color="red" icon={<SafetyCertificateOutlined />}>
          {t('groups.sensitive')}
        </Tag>
      )}
      {g.isSystem && <Tag color="gold">{t('groups.system')}</Tag>}
    </Space>
  );
}

const PANE: CSSProperties = {
  flex: '1 1 240px',
  minWidth: 230,
  border: '1px solid #EAEDF3',
  borderRadius: 10,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
};
const PANE_HEAD: CSSProperties = { fontWeight: 600, color: palette.primary, fontSize: 13 };
const PANE_BODY: CSSProperties = { maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 };

function ByGroupTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { data: groups = [], isLoading } = useGroups();
  // Categories carry the auto-assign config (strategy + roster) — a group IS a category.
  const { data: cats = [] } = useAdminCategories();
  const [selected, setSelected] = useState<number | null>(null);
  // Raw query data (no `= []` default): react-query keeps a STABLE reference until the
  // data changes, so the effect below only re-seeds when membership actually loads —
  // a defaulted `[]` would be a fresh array every render → infinite setState loop.
  const { data: members } = useGroupMembers(selected);
  const memberList = members ?? [];
  // `inGroup` is the ORDERED list of in-group member ids — it doubles as the round-robin
  // rotation order (drag to reorder). Membership + order live in ONE place (no duplicate
  // roster list under the strategy).
  const [inGroup, setInGroup] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<'round_robin' | 'least_load'>('round_robin');
  const [availQuery, setAvailQuery] = useState('');
  const [leftChecked, setLeftChecked] = useState<string[]>([]);
  const [rightChecked, setRightChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const dragFrom = useRef<number | null>(null);

  const selectedCat = cats.find((c) => c.id === selected);
  const isSystem = !!selectedCat?.isSystem;

  // Seed from saved membership + the saved auto-assign order whenever this group's data
  // (re)loads (selecting a group, or after a save refetch).
  const seedRef = useRef('');
  useEffect(() => {
    if (!members) return;
    const ids = members.filter((m) => m.inGroup && !m.disabled).map((m) => m.id);
    const cfg = cats.find((c) => c.id === selected)?.autoAssign ?? null;
    const ordered = (cfg?.members ?? []).map((m) => m.userId).filter((id) => ids.includes(id));
    const seededInGroup = [...ordered, ...ids.filter((id) => !ordered.includes(id))];
    const seededStrategy = (cfg?.strategy as 'round_robin' | 'least_load') ?? 'round_robin';
    setInGroup(seededInGroup);
    setStrategy(seededStrategy);
    setLeftChecked([]);
    setRightChecked([]);
    // Baseline for the dirty check — this same effect re-seeds on group switch, which
    // used to silently swallow unsaved edits.
    seedRef.current = JSON.stringify({ inGroup: seededInGroup, strategy: seededStrategy });
  }, [members, cats, selected]);

  const dirty =
    selected !== null &&
    seedRef.current !== '' &&
    JSON.stringify({ inGroup, strategy }) !== seedRef.current;

  // Guard the two loss paths: picking another group (re-seed wipes state) and
  // closing/refreshing the tab. In-app route changes are rare here and the save
  // button sits next to the panes, so a router blocker is deliberately skipped.
  const selectGroup = (id: number) => {
    if (id === selected) return;
    if (!dirty) {
      setSelected(id);
      return;
    }
    modal.confirm({
      title: t('groups.unsavedWarn'),
      okButtonProps: { danger: true },
      onOk: () => setSelected(id),
    });
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const userOf = (id: string) => memberList.find((m) => m.id === id);
  const available = memberList.filter(
    (m) =>
      !m.disabled &&
      !inGroup.includes(m.id) &&
      (m.name + m.email).toLowerCase().includes(availQuery.trim().toLowerCase()),
  );
  const toggle = (arr: string[], set: (v: string[]) => void, id: string) =>
    set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  const moveRight = () => {
    setInGroup((p) => [...p, ...leftChecked.filter((id) => !p.includes(id))]);
    setLeftChecked([]);
  };
  const moveLeft = () => {
    setInGroup((p) => p.filter((id) => !rightChecked.includes(id)));
    setRightChecked([]);
  };
  const removeFromGroup = (id: string) => setInGroup((p) => p.filter((x) => x !== id));
  const drop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;
    setInGroup((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
    qc.invalidateQueries({ queryKey: ['admin', 'categories'] });
  };

  const save = async () => {
    if (selected === null) return;
    setSaving(true);
    try {
      await setGroupMembers(selected, inGroup);
      // Persist the rotation strategy + order (= the in-group list order). Skipped for the
      // system "Khác" group and for an empty roster (removal already prunes the config).
      if (!isSystem && inGroup.length > 0) {
        await putAutoAssign(selected, { strategy, members: inGroup });
      }
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
        onRow={(g) => ({ onClick: () => selectGroup(g.categoryId), style: { cursor: 'pointer' } })}
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
      <div style={{ flex: '2 1 520px', minWidth: 360 }}>
        {selected === null ? (
          <Alert type="info" showIcon message={t('groups.pickGroupHint')} />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              {/* Ngoài nhóm — tick users, then use the → button to add them to the group. */}
              <div style={PANE}>
                <div style={PANE_HEAD}>
                  {t('groups.available')} ({available.length})
                </div>
                <Input
                  size="small"
                  allowClear
                  placeholder={t('groups.searchMember')}
                  value={availQuery}
                  onChange={(e) => setAvailQuery(e.target.value)}
                  style={{ margin: '8px 0' }}
                />
                <div style={PANE_BODY}>
                  {available.map((u) => (
                    <div
                      key={u.id}
                      className="group-row"
                      onClick={() => toggle(leftChecked, setLeftChecked, u.id)}
                    >
                      <Checkbox
                        checked={leftChecked.includes(u.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(leftChecked, setLeftChecked, u.id)}
                      />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        {u.name}{' '}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {u.email}
                        </Text>
                      </span>
                    </div>
                  ))}
                  {available.length === 0 && <Text type="secondary">—</Text>}
                </div>
              </div>

              {/* Move arrows (Transfer-style). */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Button
                  icon={<RightOutlined />}
                  disabled={leftChecked.length === 0}
                  onClick={moveRight}
                />
                <Button
                  icon={<LeftOutlined />}
                  disabled={rightChecked.length === 0}
                  onClick={moveLeft}
                />
              </div>

              {/* Trong nhóm — tick + ← to remove; DRAG a row to reorder (= round-robin order). */}
              <div style={PANE}>
                <div style={PANE_HEAD}>
                  {t('groups.inGroup')} ({inGroup.length})
                </div>
                <div style={{ ...PANE_BODY, marginTop: 8 }}>
                  {inGroup.map((id, i) => {
                    const u = userOf(id);
                    return (
                      <div
                        key={id}
                        className="group-row group-row--drag"
                        draggable
                        onDragStart={() => (dragFrom.current = i)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => drop(i)}
                      >
                        <Checkbox
                          checked={rightChecked.includes(id)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggle(rightChecked, setRightChecked, id)}
                        />
                        <HolderOutlined className="drag-handle" />
                        {/* Auto-assign hidden (FE): round-robin order number suppressed. */}
                        <span style={{ flex: 1, minWidth: 0 }}>{u?.name ?? id}</span>
                        <CloseOutlined
                          onClick={() => removeFromGroup(id)}
                          style={{ color: '#D14343', cursor: 'pointer' }}
                        />
                      </div>
                    );
                  })}
                  {inGroup.length === 0 && <Text type="secondary">{t('groups.zeroMembers')}</Text>}
                </div>
              </div>
            </div>

            {/* Auto-assign (round-robin / least-load) UI hidden — the feature is turned OFF
                at the backend (AUTO_ASSIGN_ENABLED=false); every ticket lands in the group
                pool for a Member/TL to self-claim. The roster (membership + order) above is
                still saved, so re-enabling later is just restoring this block. */}

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
    () =>
      groups.map((g) => ({
        label: (
          <span>
            {g.nameVi}
            {g.isSensitive && <SafetyCertificateOutlined style={{ color: '#D14343', marginLeft: 4 }} />}
          </span>
        ),
        value: g.categoryId,
      })),
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
          // CR-2: disabled accounts are locked out at the session layer — offering
          // them here only invites pointless membership edits, so hide them (the
          // by-group panes already exclude disabled users the same way).
          options={users
            .filter((u) => u.role !== 'ssa' && !u.disabled)
            .map((u) => ({
              value: u.id,
              label: `${u.name} (${u.email})`,
            }))}
        />
      </div>
      {userId && (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('groups.pickUserHint')}
          </Text>
          <div
            style={{
              border: '1px solid #EAEDF3',
              borderRadius: 8,
              padding: '14px 16px',
              maxHeight: 360,
              overflowY: 'auto',
            }}
          >
            <Checkbox.Group
              style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              options={options}
              value={checked}
              onChange={(v) => setChecked(v as number[])}
            />
          </div>
          <Button type="primary" loading={saving} onClick={save}>
            {t('common.save')}
          </Button>
        </>
      )}
    </Space>
  );
}
