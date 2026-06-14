import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  Card,
  Table,
  Button,
  Tag,
  Switch,
  Drawer,
  Input,
  Select,
  Radio,
  Space,
  Tabs,
  Popconfirm,
  Typography,
  App as AntApp,
} from 'antd';
import {
  useAdminCategories,
  useAdminUsers,
  useAdminTags,
  createCategory,
  updateCategory,
  deleteCategory,
  putAutoAssign,
  createTag,
  updateTag,
  deleteTag,
  type AdminCategory,
  type AdminTag,
} from '../../lib/admin';

const { Text } = Typography;

/** Admin "Danh mục & Phân loại" + Tag management (Story 4.6, FR86/FR87/FR32). */
export function CategoriesPage() {
  const { t } = useTranslation();
  return (
    <Card title={t('admin.categoriesTitle')}>
      <Tabs
        items={[
          { key: 'cat', label: t('admin.tabCategories'), children: <CategoriesTab /> },
          { key: 'tag', label: t('admin.tabTags'), children: <TagsTab /> },
        ]}
      />
    </Card>
  );
}

function CategoriesTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { data: cats = [], isLoading } = useAdminCategories();
  const { data: users = [] } = useAdminUsers();
  const [editing, setEditing] = useState<AdminCategory | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'categories'] });

  const onDelete = async (c: AdminCategory) => {
    try {
      await deleteCategory(c.id);
      message.success(t('admin.deleted'));
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <>
      <Button type="primary" style={{ marginBottom: 12 }} onClick={() => setEditing('new')}>
        {t('admin.addCategory')}
      </Button>
      <Table<AdminCategory>
        rowKey="id"
        loading={isLoading}
        dataSource={cats}
        pagination={false}
        columns={[
          { title: t('admin.nameVi'), dataIndex: 'nameVi' },
          { title: t('admin.nameEn'), dataIndex: 'nameEn' },
          {
            title: t('admin.keywords'),
            dataIndex: 'keywords',
            render: (k: string[]) => (
              <Space size={4} wrap>
                {k.map((w) => (
                  <Tag key={w}>{w}</Tag>
                ))}
              </Space>
            ),
          },
          {
            title: t('admin.sensitive'),
            dataIndex: 'isSensitive',
            width: 110,
            render: (s: boolean) => (s ? <Tag color="red">{t('admin.sensitive')}</Tag> : '—'),
          },
          {
            title: t('admin.autoAssign'),
            dataIndex: 'autoAssign',
            render: (a: AdminCategory['autoAssign']) =>
              a ? `${t(`admin.${a.strategy}`)} · ${a.members.length}` : '—',
          },
          {
            title: t('ticket.status'),
            render: (_: unknown, c: AdminCategory) =>
              c.isSystem ? (
                <Tag color="gold">{t('admin.system')}</Tag>
              ) : c.disabled ? (
                <Tag>{t('admin.disabled')}</Tag>
              ) : (
                <Tag color="green">{t('admin.active')}</Tag>
              ),
          },
          {
            title: '',
            render: (_: unknown, c: AdminCategory) =>
              c.isSystem ? null : (
                <Space>
                  <Button size="small" onClick={() => setEditing(c)}>
                    {t('common.edit')}
                  </Button>
                  <Popconfirm
                    title={c.ticketCount > 0 ? t('admin.hasTicketsDisable') : t('admin.confirmDelete')}
                    onConfirm={() => onDelete(c)}
                  >
                    <Button size="small" danger>
                      {t('common.delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
          },
        ]}
      />
      {editing && (
        <CategoryDrawer
          value={editing}
          users={users.filter((u) => !u.disabled)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

function CategoryDrawer({
  value,
  users,
  onClose,
  onSaved,
}: {
  value: AdminCategory | 'new';
  users: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const isNew = value === 'new';
  const cat = isNew ? null : value;
  const [nameVi, setNameVi] = useState(cat?.nameVi ?? '');
  const [nameEn, setNameEn] = useState(cat?.nameEn ?? '');
  const [sensitive, setSensitive] = useState(cat?.isSensitive ?? false);
  const [keywords, setKeywords] = useState<string[]>(cat?.keywords ?? []);
  const [strategy, setStrategy] = useState<'round_robin' | 'least_load'>(
    (cat?.autoAssign?.strategy as 'round_robin' | 'least_load') ?? 'round_robin',
  );
  const [members, setMembers] = useState<string[]>(cat?.autoAssign?.members.map((m) => m.userId) ?? []);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      let id = cat?.id;
      if (isNew) {
        const res = await createCategory({ nameVi, nameEn, isSensitive: sensitive, keywords });
        id = res.id;
      } else {
        await updateCategory(cat!.id, { nameVi, nameEn, isSensitive: sensitive, keywords });
      }
      if (id) await putAutoAssign(id, { strategy, members });
      message.success(t('admin.saved'));
      onSaved();
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
      title={isNew ? t('admin.addCategory') : t('admin.editCategory')}
      onClose={onClose}
      extra={
        <Button type="primary" loading={saving} onClick={save}>
          {t('common.save')}
        </Button>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Text>{t('admin.nameVi')}</Text>
          <Input value={nameVi} onChange={(e) => setNameVi(e.target.value)} />
        </div>
        <div>
          <Text>{t('admin.nameEn')}</Text>
          <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </div>
        <Space>
          <Switch checked={sensitive} onChange={setSensitive} />
          <Text>{t('admin.sensitive')}</Text>
        </Space>
        <div>
          <Text>{t('admin.keywords')}</Text>
          <Select
            mode="tags"
            style={{ width: '100%' }}
            value={keywords}
            onChange={setKeywords}
            placeholder={t('admin.keywordsHint')}
            tokenSeparators={[',']}
          />
        </div>
        <div>
          <Text strong>{t('admin.autoAssign')}</Text>
          <div style={{ marginTop: 4 }}>
            <Radio.Group value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <Radio value="round_robin">{t('admin.round_robin')}</Radio>
              <Radio value="least_load">{t('admin.least_load')}</Radio>
            </Radio.Group>
          </div>
          <Select
            mode="multiple"
            style={{ width: '100%', marginTop: 8 }}
            value={members}
            onChange={setMembers}
            placeholder={t('admin.pickMembers')}
            optionFilterProp="label"
            options={users.map((u) => ({ value: u.id, label: u.name }))}
          />
          <Text type="secondary">{t('admin.orderHint')}</Text>
        </div>
      </Space>
    </Drawer>
  );
}

function TagsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { data: tags = [], isLoading } = useAdminTags();
  const [editing, setEditing] = useState<AdminTag | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'tags'] });

  const onDelete = async (tag: AdminTag) => {
    try {
      const res = await deleteTag(tag.id, false);
      if ('needsConfirm' in res) {
        const ok = window.confirm(t('admin.tagAttached', { n: res.attachedTo }));
        if (!ok) return;
        await deleteTag(tag.id, true);
      }
      message.success(t('admin.deleted'));
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <>
      <Button type="primary" style={{ marginBottom: 12 }} onClick={() => setEditing('new')}>
        {t('admin.addTag')}
      </Button>
      <Table<AdminTag>
        rowKey="id"
        loading={isLoading}
        dataSource={tags}
        pagination={false}
        columns={[
          {
            title: t('admin.tag'),
            render: (_: unknown, tg: AdminTag) => <Tag color={tg.color ?? 'default'}>{tg.name}</Tag>,
          },
          { title: t('admin.kind'), dataIndex: 'kind', render: (k: string) => t(`admin.tagKind_${k}`) },
          {
            title: t('admin.keywords'),
            dataIndex: 'keywords',
            render: (k: string[]) => (
              <Space size={4} wrap>
                {k.map((w) => (
                  <Tag key={w}>{w}</Tag>
                ))}
              </Space>
            ),
          },
          { title: t('admin.usedBy'), dataIndex: 'ticketCount', width: 90 },
          {
            title: '',
            render: (_: unknown, tg: AdminTag) =>
              tg.kind === 'auto' ? (
                <Tag color="gold">{t('admin.autoTag')}</Tag>
              ) : (
                <Space>
                  <Button size="small" onClick={() => setEditing(tg)}>
                    {t('common.edit')}
                  </Button>
                  <Button size="small" danger onClick={() => onDelete(tg)}>
                    {t('common.delete')}
                  </Button>
                </Space>
              ),
          },
        ]}
      />
      {editing && <TagDrawer value={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
    </>
  );
}

function TagDrawer({ value, onClose, onSaved }: { value: AdminTag | 'new'; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const isNew = value === 'new';
  const tag = isNew ? null : value;
  const [name, setName] = useState(tag?.name ?? '');
  const [kind, setKind] = useState<'manual' | 'priority'>((tag?.kind as 'manual' | 'priority') ?? 'manual');
  const [color, setColor] = useState(tag?.color ?? '');
  const [keywords, setKeywords] = useState<string[]>(tag?.keywords ?? []);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      if (isNew) {
        await createTag({ name, kind, color: color || undefined, keywords: kind === 'priority' ? keywords : undefined });
      } else {
        await updateTag(tag!.id, { name, color: color || undefined, keywords: tag!.kind === 'priority' ? keywords : undefined });
      }
      message.success(t('admin.saved'));
      onSaved();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const priority = (isNew ? kind : tag?.kind) === 'priority';

  return (
    <Drawer
      open
      width={380}
      title={isNew ? t('admin.addTag') : t('admin.editTag')}
      onClose={onClose}
      extra={
        <Button type="primary" loading={saving} onClick={save}>
          {t('common.save')}
        </Button>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Text>{t('admin.tag')}</Text>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {isNew && (
          <div>
            <Text>{t('admin.kind')}</Text>
            <Radio.Group value={kind} onChange={(e) => setKind(e.target.value)} style={{ display: 'block', marginTop: 4 }}>
              <Radio value="manual">{t('admin.tagKind_manual')}</Radio>
              <Radio value="priority">{t('admin.tagKind_priority')}</Radio>
            </Radio.Group>
          </div>
        )}
        <div>
          <Text>{t('admin.color')}</Text>
          <Input value={color} onChange={(e) => setColor(e.target.value)} placeholder="#f5222d" />
        </div>
        {priority && (
          <div>
            <Text>{t('admin.priorityKeywords')}</Text>
            <Select mode="tags" style={{ width: '100%' }} value={keywords} onChange={setKeywords} tokenSeparators={[',']} />
          </div>
        )}
      </Space>
    </Drawer>
  );
}
