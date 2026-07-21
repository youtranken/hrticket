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
  ColorPicker,
  Space,
  Tabs,
  Popconfirm,
  Tooltip,
  Typography,
  App as AntApp,
} from 'antd';
import { SafetyCertificateOutlined, PlusOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components/PageHeader';
import { palette } from '../../theme';
import {
  useAdminCategories,
  useAdminTags,
  createCategory,
  updateCategory,
  deleteCategory,
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
    <div>
      <PageHeader title={t('admin.categoriesTitle')} subtitle={t('admin.categoriesSubtitle')} />
      <Card>
        <Tabs
          items={[
            { key: 'cat', label: t('admin.tabCategories'), children: <CategoriesTab /> },
            { key: 'tag', label: t('admin.tabTags'), children: <TagsTab /> },
          ]}
        />
      </Card>
    </div>
  );
}

function CategoriesTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { data: cats = [], isLoading } = useAdminCategories();
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

  // Disable Pool (đơn 4): stop the pool without deleting it — intake classification
  // skips disabled categories, so new mail falls back to "Khác"; existing tickets
  // stay untouched and finish out where they are.
  const onToggleDisabled = async (c: AdminCategory) => {
    try {
      await updateCategory(c.id, { disabled: !c.disabled });
      message.success(t('admin.saved'));
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
          {t('admin.addCategory')}
        </Button>
      </div>
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
            title: t('admin.senderDomains'),
            dataIndex: 'senderPatterns',
            render: (p: string[] = []) => (
              <Space size={4} wrap>
                {p.map((w) => (
                  <Tag key={w} color="blue">
                    {w}
                  </Tag>
                ))}
              </Space>
            ),
          },
          {
            title: t('admin.sensitive'),
            dataIndex: 'isSensitive',
            width: 110,
            render: (s: boolean) =>
              s ? (
                <Tag color="red" icon={<SafetyCertificateOutlined />}>
                  {t('admin.sensitive')}
                </Tag>
              ) : (
                '—'
              ),
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
            title: t('common.actions'),
            width: 240,
            render: (_: unknown, c: AdminCategory) =>
              c.isSystem ? null : (
                <Space>
                  <Button size="small" onClick={() => setEditing(c)}>
                    {t('common.edit')}
                  </Button>
                  <Popconfirm
                    title={c.disabled ? t('admin.confirmEnablePool') : t('admin.confirmDisablePool')}
                    onConfirm={() => onToggleDisabled(c)}
                  >
                    <Switch
                      size="small"
                      checked={!c.disabled}
                      checkedChildren={t('admin.active')}
                      unCheckedChildren={t('admin.disabled')}
                    />
                  </Popconfirm>
                  {/* With live tickets the BE refuses the delete anyway — a disabled
                      button + tooltip beats a confirm that only leads to an error. */}
                  {c.ticketCount > 0 ? (
                    <Tooltip title={t('admin.hasTicketsDisable')}>
                      <Button size="small" danger disabled>
                        {t('common.delete')}
                      </Button>
                    </Tooltip>
                  ) : (
                    <Popconfirm
                      title={t('admin.confirmDelete', { name: c.nameVi })}
                      onConfirm={() => onDelete(c)}
                    >
                      <Button size="small" danger>
                        {t('common.delete')}
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
          },
        ]}
      />
      {editing && (
        <CategoryDrawer
          value={editing}
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
  onClose,
  onSaved,
}: {
  value: AdminCategory | 'new';
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
  const [senderPatterns, setSenderPatterns] = useState<string[]>(cat?.senderPatterns ?? []);
  const [saving, setSaving] = useState(false);

  // Categories are pure taxonomy now — name, keywords, sender domains, sensitivity. People
  // & work distribution (membership + auto-assign rotation) live together in /admin/groups.
  const save = async () => {
    setSaving(true);
    try {
      if (isNew) {
        await createCategory({ nameVi, nameEn, isSensitive: sensitive, keywords, senderPatterns });
      } else {
        await updateCategory(cat!.id, { nameVi, nameEn, isSensitive: sensitive, keywords, senderPatterns });
      }
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
        <Button type="primary" loading={saving} disabled={!nameVi.trim() || !nameEn.trim()} onClick={save}>
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
          <Text>{t('admin.senderDomains')}</Text>
          <Select
            mode="tags"
            style={{ width: '100%' }}
            value={senderPatterns}
            onChange={setSenderPatterns}
            placeholder={t('admin.senderDomainsHint')}
            tokenSeparators={[',', ' ']}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('admin.senderDomainsNote')}
          </Text>
        </div>
      </Space>
    </Drawer>
  );
}

function TagsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { data: tags = [], isLoading } = useAdminTags();
  const [editing, setEditing] = useState<AdminTag | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'tags'] });

  const onDelete = async (tag: AdminTag) => {
    try {
      const res = await deleteTag(tag.id, false);
      if ('needsConfirm' in res) {
        // A styled confirm (the static window.confirm is unlocalized + ugly) showing how
        // many tickets still carry the tag before a forced delete.
        modal.confirm({
          title: t('admin.confirmDelete', { name: tag.name }),
          content: t('admin.tagAttached', { n: res.attachedTo }),
          okButtonProps: { danger: true },
          onOk: async () => {
            await deleteTag(tag.id, true);
            message.success(t('admin.deleted'));
            refresh();
          },
        });
        return;
      }
      message.success(t('admin.deleted'));
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
          {t('admin.addTag')}
        </Button>
      </div>
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
            title: t('common.actions'),
            width: 150,
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
        <Button type="primary" loading={saving} disabled={!name.trim()} onClick={save}>
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
          <Text style={{ display: 'block', marginBottom: 4 }}>{t('admin.color')}</Text>
          <ColorPicker
            value={color || '#f5222d'}
            onChange={(_, hex) => setColor(hex)}
            showText
            format="hex"
            presets={[
              {
                label: t('admin.color'),
                colors: ['#D14343', '#D97706', '#E8B11C', '#1F9D6B', '#0E7490', palette.primary, '#7C3AED', '#8C95A8'],
              },
            ]}
          />
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
