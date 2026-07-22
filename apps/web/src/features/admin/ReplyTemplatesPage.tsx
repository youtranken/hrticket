import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Table, Button, Modal, Form, Input, Select, Switch, Tag, Space, Typography, App as AntApp } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import {
  useReplyTemplates,
  useAddTemplate,
  useUpdateTemplate,
  useRemoveTemplate,
  useSetTemplateEnabled,
  type ReplyTemplate,
} from '../../lib/replyTemplates';
import { useAdminCategories } from '../../lib/admin';

const { Text, Paragraph } = Typography;

/** Canned reply templates manager (SSA/Admin/TL). Bodies may use {{ticketCode}},
 *  {{requesterName}}, {{agentName}} — substituted when an agent inserts the template.
 *  12.2: templates can be scoped to a category (or common) and soft-disabled. */
export function ReplyTemplatesPage() {
  const { t, i18n } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: rows = [], isLoading } = useReplyTemplates({ includeDisabled: true });
  const { data: cats = [] } = useAdminCategories();
  const add = useAddTemplate();
  const update = useUpdateTemplate();
  const remove = useRemoveTemplate();
  const setEnabled = useSetTemplateEnabled();
  const [editing, setEditing] = useState<ReplyTemplate | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ title: string; body: string; categoryId: number | null }>();

  const catName = (id: number | null): string => {
    if (id == null) return t('tpl.common');
    const c = cats.find((x) => x.id === id);
    if (!c) return `#${id}`;
    return i18n.language === 'en' ? c.nameEn : c.nameVi;
  };
  const catOptions = [
    { value: null as number | null, label: t('tpl.common') },
    ...cats.map((c) => ({ value: c.id as number | null, label: i18n.language === 'en' ? c.nameEn : c.nameVi })),
  ];

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ categoryId: null });
    setOpen(true);
  };
  const openEdit = (row: ReplyTemplate) => {
    setEditing(row);
    form.setFieldsValue({ title: row.title, body: row.body, categoryId: row.categoryId });
    setOpen(true);
  };

  const submit = (v: { title: string; body: string; categoryId: number | null }) => {
    const onDone = () => {
      message.success(t('tpl.saved'));
      setOpen(false);
    };
    const onErr = (e: Error) => message.error(e.message);
    if (editing) update.mutate({ id: editing.id, ...v }, { onSuccess: onDone, onError: onErr });
    else add.mutate(v, { onSuccess: onDone, onError: onErr });
  };

  const toggleEnabled = (row: ReplyTemplate, enabled: boolean) =>
    setEnabled
      .mutateAsync({ id: row.id, enabled })
      .then(() => message.success(enabled ? t('tpl.enabled') : t('tpl.disabled')))
      .catch((e: Error) => message.error(e.message));

  const onRemove = (row: ReplyTemplate) =>
    modal.confirm({
      title: t('tpl.confirmRemove', { title: row.title }),
      okButtonProps: { danger: true },
      onOk: () =>
        remove
          .mutateAsync(row.id)
          .then(() => message.success(t('tpl.removed')))
          .catch((e: Error) => message.error(e.message)),
    });

  return (
    <Card
      title={t('tpl.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('tpl.add')}
        </Button>
      }
    >
      <Paragraph type="secondary">
        {t('tpl.hint')} <Text code>{'{{ticketCode}}'}</Text> <Text code>{'{{requesterName}}'}</Text>{' '}
        <Text code>{'{{agentName}}'}</Text>
      </Paragraph>
      <Table<ReplyTemplate>
        rowKey="id"
        loading={isLoading}
        dataSource={rows}
        pagination={false}
        rowClassName={(row) => (row.enabled ? '' : 'row-disabled')}
        columns={[
          {
            title: t('tpl.colTitle'),
            dataIndex: 'title',
            width: 240,
            render: (title: string, row: ReplyTemplate) => (
              <Space>
                <Text delete={!row.enabled}>{title}</Text>
                {!row.enabled && <Tag>{t('tpl.disabled')}</Tag>}
              </Space>
            ),
          },
          {
            title: t('tpl.colCategory'),
            dataIndex: 'categoryId',
            width: 160,
            render: (id: number | null) =>
              id == null ? <Tag color="blue">{t('tpl.common')}</Tag> : <Tag>{catName(id)}</Tag>,
          },
          {
            title: t('tpl.colBody'),
            dataIndex: 'body',
            render: (b: string) => (
              <Text type="secondary" ellipsis style={{ maxWidth: 420 }}>
                {b}
              </Text>
            ),
          },
          {
            title: t('tpl.colEnabled'),
            dataIndex: 'enabled',
            width: 90,
            render: (enabled: boolean, row: ReplyTemplate) => (
              <Switch
                checked={enabled}
                loading={setEnabled.isPending}
                onChange={(v) => toggleEnabled(row, v)}
              />
            ),
          },
          {
            title: '',
            width: 210,
            render: (_: unknown, row: ReplyTemplate) => (
              <Space>
                {/* P2 #5: full-body preview — the list cell only ellipsizes. */}
                <Button
                  size="small"
                  onClick={() =>
                    modal.info({
                      title: row.title,
                      width: 560,
                      content: (
                        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{row.body}</pre>
                      ),
                    })
                  }
                >
                  {t('tpl.preview')}
                </Button>
                <Button size="small" onClick={() => openEdit(row)}>
                  {t('common.edit')}
                </Button>
                <Button size="small" danger onClick={() => onRemove(row)}>
                  {t('common.delete')}
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={open}
        title={editing ? t('tpl.editTitle') : t('tpl.add')}
        okText={t('common.save')}
        onOk={() => form.submit()}
        onCancel={() => setOpen(false)}
        confirmLoading={add.isPending || update.isPending}
        destroyOnClose
        width={620}
      >
        <Form form={form} layout="vertical" onFinish={submit} preserve={false}>
          <Form.Item label={t('tpl.colTitle')} name="title" rules={[{ required: true, message: t('tpl.titleRequired') }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item label={t('tpl.colCategory')} name="categoryId" extra={t('tpl.categoryHint')}>
            <Select options={catOptions} allowClear={false} />
          </Form.Item>
          <Form.Item
            label={t('tpl.colBody')}
            name="body"
            rules={[{ required: true, message: t('tpl.bodyRequired') }]}
            extra={
              <>
                {t('tpl.placeholderHint')} <Text code>{'{{ticketCode}}'}</Text>{' '}
                <Text code>{'{{requesterName}}'}</Text> <Text code>{'{{agentName}}'}</Text>
              </>
            }
          >
            <Input.TextArea rows={8} maxLength={20000} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
