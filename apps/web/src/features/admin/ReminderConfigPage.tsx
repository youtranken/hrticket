import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Form,
  InputNumber,
  Input,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  App as AntApp,
} from 'antd';
import {
  useReminderConfig,
  useSaveReminderConfig,
  useEmailTemplates,
  useSaveTemplate,
  testSendTemplate,
  type EmailTemplate,
} from '../../lib/adminReminders';

const { Title, Text } = Typography;

/** Admin "Reminder settings" (Story 6.4): the shared overdue threshold + digest
 *  schedule, plus an email-template editor with a live "send test" to the admin. */
export function ReminderConfigPage() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { data: cfg } = useReminderConfig();
  const save = useSaveReminderConfig();
  const [form] = Form.useForm();

  useEffect(() => {
    if (cfg) form.setFieldsValue(cfg);
  }, [cfg, form]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 760 }}>
      <Title level={4}>{t('reminders.title')}</Title>

      <Card title={t('reminders.scheduleTitle')}>
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) =>
            save.mutate(v, {
              onSuccess: () => message.success(t('reminders.saved')),
              onError: (e) => message.error(e.message),
            })
          }
        >
          <Form.Item name="overdueDays" label={t('reminders.overdueDays')} rules={[{ required: true }]}>
            <InputNumber min={1} max={60} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="digestHour" label={t('reminders.digestHour')} rules={[{ required: true }]}>
            <InputNumber min={0} max={23} style={{ width: 120 }} addonAfter="h" />
          </Form.Item>
          <Form.Item name="digestMaxN" label={t('reminders.digestMaxN')} rules={[{ required: true }]}>
            <InputNumber min={1} max={100} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="digestEnabled" label={t('reminders.digestEnabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </Form>
        <Alert style={{ marginTop: 16 }} type="info" showIcon message={t('reminders.fixedNote')} />
      </Card>

      <TemplateEditor />
    </Space>
  );
}

function TemplateEditor() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { data: templates } = useEmailTemplates();
  const save = useSaveTemplate();
  const [key, setKey] = useState<string | undefined>();
  const [draft, setDraft] = useState<EmailTemplate | null>(null);
  const [sending, setSending] = useState(false);

  const pick = (k: string) => {
    setKey(k);
    setDraft(templates?.find((tp) => tp.key === k) ?? null);
  };

  const onSave = () => {
    if (!draft) return;
    save.mutate(
      {
        key: draft.key,
        subjectVi: draft.subjectVi,
        subjectEn: draft.subjectEn,
        bodyVi: draft.bodyVi,
        bodyEn: draft.bodyEn,
      },
      {
        onSuccess: () => message.success(t('reminders.templateSaved')),
        onError: (e) => message.error(e.message), // unknown placeholder → 422 message
      },
    );
  };

  const onTest = async () => {
    if (!key) return;
    setSending(true);
    try {
      const res = await testSendTemplate(key);
      message.success(t('reminders.testSent', { to: res.to }));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Card title={t('reminders.templatesTitle')}>
      <Select
        style={{ width: 280, marginBottom: 12 }}
        placeholder={t('reminders.pickTemplate')}
        value={key}
        onChange={pick}
        options={(templates ?? []).map((tp) => ({ value: tp.key, label: t(`reminders.tpl.${tp.key}`, { defaultValue: tp.key }) }))}
      />
      {draft && (
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Text type="secondary">
            {t('reminders.placeholders')}: {draft.placeholders.map((p) => <Tag key={p}>{`{{${p}}}`}</Tag>)}
          </Text>
          <Input
            addonBefore="Subject (VI)"
            value={draft.subjectVi}
            onChange={(e) => setDraft({ ...draft, subjectVi: e.target.value })}
          />
          <Input
            addonBefore="Subject (EN)"
            value={draft.subjectEn}
            onChange={(e) => setDraft({ ...draft, subjectEn: e.target.value })}
          />
          <Input.TextArea
            rows={4}
            value={draft.bodyVi}
            onChange={(e) => setDraft({ ...draft, bodyVi: e.target.value })}
            placeholder="Body (VI)"
          />
          <Input.TextArea
            rows={4}
            value={draft.bodyEn}
            onChange={(e) => setDraft({ ...draft, bodyEn: e.target.value })}
            placeholder="Body (EN)"
          />
          <Space>
            <Button type="primary" onClick={onSave} loading={save.isPending}>
              {t('common.save')}
            </Button>
            <Button onClick={onTest} loading={sending}>
              {t('reminders.testSend')}
            </Button>
          </Space>
        </Space>
      )}
    </Card>
  );
}
