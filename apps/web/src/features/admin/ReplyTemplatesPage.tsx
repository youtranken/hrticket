import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Table, Button, Modal, Form, Input, Space, Typography, App as AntApp } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import {
  useReplyTemplates,
  useAddTemplate,
  useUpdateTemplate,
  useRemoveTemplate,
  type ReplyTemplate,
} from '../../lib/replyTemplates';

const { Text, Paragraph } = Typography;

/** Canned reply templates manager (SSA/Admin/TL). Bodies may use {{ticketCode}},
 *  {{requesterName}}, {{agentName}} — substituted when an agent inserts the template. */
export function ReplyTemplatesPage() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: rows = [], isLoading } = useReplyTemplates();
  const add = useAddTemplate();
  const update = useUpdateTemplate();
  const remove = useRemoveTemplate();
  const [editing, setEditing] = useState<ReplyTemplate | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ title: string; body: string }>();

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };
  const openEdit = (row: ReplyTemplate) => {
    setEditing(row);
    form.setFieldsValue({ title: row.title, body: row.body });
    setOpen(true);
  };

  const submit = (v: { title: string; body: string }) => {
    const onDone = () => {
      message.success(t('tpl.saved'));
      setOpen(false);
    };
    const onErr = (e: Error) => message.error(e.message);
    if (editing) update.mutate({ id: editing.id, ...v }, { onSuccess: onDone, onError: onErr });
    else add.mutate(v, { onSuccess: onDone, onError: onErr });
  };

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
        columns={[
          { title: t('tpl.colTitle'), dataIndex: 'title', width: 240 },
          {
            title: t('tpl.colBody'),
            dataIndex: 'body',
            render: (b: string) => (
              <Text type="secondary" ellipsis style={{ maxWidth: 480 }}>
                {b}
              </Text>
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
