import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ClockCircleOutlined, MailOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import {
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Input,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  App as AntApp,
} from 'antd';
import { PageHeader } from '../../components/PageHeader';
import { palette } from '../../theme';
import {
  useReminderConfig,
  useSaveReminderConfig,
  useEmailTemplates,
  useSaveTemplate,
  testSendTemplate,
  type EmailTemplate,
} from '../../lib/adminReminders';

const { Text } = Typography;

/** A labelled field — caption above a full-width control, consistent spacing. */
function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
        {label}
      </Text>
      {children}
    </div>
  );
}

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
    <div style={{ maxWidth: 820 }}>
      <PageHeader title={t('reminders.title')} subtitle={t('reminders.subtitle')} />

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card
          size="small"
          title={
            <Space>
              <ClockCircleOutlined style={{ color: palette.primary }} />
              {t('reminders.scheduleTitle')}
            </Space>
          }
        >
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
            <Row gutter={16}>
              <Col xs={24} sm={8}>
                <Form.Item
                  name="overdueDays"
                  label={t('reminders.overdueDays')}
                  rules={[{ required: true }]}
                >
                  <InputNumber min={1} max={60} style={{ width: '100%' }} addonAfter={t('reminders.daysUnit')} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={8}>
                <Form.Item
                  name="poolUnclaimedDays"
                  label={t('reminders.poolUnclaimedDays')}
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} max={60} style={{ width: '100%' }} addonAfter={t('reminders.daysUnit')} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={8}>
                <Form.Item
                  name="digestMaxN"
                  label={t('reminders.digestMaxN')}
                  rules={[{ required: true }]}
                >
                  <InputNumber min={1} max={100} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col xs={24} sm={8}>
                <Form.Item
                  name="digestHour"
                  label={t('reminders.digestHour')}
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} max={23} style={{ width: '100%' }} addonAfter="h" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={8}>
                <Form.Item
                  name="digestMinute"
                  label={t('reminders.digestMinute')}
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} max={59} style={{ width: '100%' }} addonAfter="m" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item
              name="digestEnabled"
              label={t('reminders.digestEnabled')}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={save.isPending}>
              {t('common.save')}
            </Button>
          </Form>
        </Card>

        <TemplateEditor />
      </Space>
    </div>
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
    <Card
      size="small"
      title={
        <Space>
          <MailOutlined style={{ color: palette.primary }} />
          {t('reminders.templatesTitle')}
        </Space>
      }
    >
      <Field label={t('reminders.pickTemplate')}>
        <Select
          style={{ width: '100%', maxWidth: 360 }}
          placeholder={t('reminders.pickTemplate')}
          value={key}
          onChange={pick}
          options={(templates ?? []).map((tp) => ({
            value: tp.key,
            label: t(`reminders.tpl.${tp.key}`, { defaultValue: tp.key }),
          }))}
        />
      </Field>
      {draft && (
        <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: 16 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('reminders.placeholders')}
            </Text>
            <div style={{ marginTop: 4 }}>
              <Space size={4} wrap>
                {draft.placeholders.map((p) => (
                  <Tag key={p} color="blue">{`{{${p}}}`}</Tag>
                ))}
              </Space>
            </div>
          </div>
          <Row gutter={[16, 12]}>
            <Col xs={24} md={12}>
              <Field label={t('reminders.subjectVi')}>
                <Input
                  value={draft.subjectVi}
                  onChange={(e) => setDraft({ ...draft, subjectVi: e.target.value })}
                />
              </Field>
            </Col>
            <Col xs={24} md={12}>
              <Field label={t('reminders.subjectEn')}>
                <Input
                  value={draft.subjectEn}
                  onChange={(e) => setDraft({ ...draft, subjectEn: e.target.value })}
                />
              </Field>
            </Col>
            <Col xs={24} md={12}>
              <Field label={t('reminders.bodyVi')}>
                <Input.TextArea
                  rows={6}
                  value={draft.bodyVi}
                  onChange={(e) => setDraft({ ...draft, bodyVi: e.target.value })}
                />
              </Field>
            </Col>
            <Col xs={24} md={12}>
              <Field label={t('reminders.bodyEn')}>
                <Input.TextArea
                  rows={6}
                  value={draft.bodyEn}
                  onChange={(e) => setDraft({ ...draft, bodyEn: e.target.value })}
                />
              </Field>
            </Col>
          </Row>
          <Space>
            <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={save.isPending}>
              {t('common.save')}
            </Button>
            <Button icon={<SendOutlined />} onClick={onTest} loading={sending}>
              {t('reminders.testSend')}
            </Button>
          </Space>
        </Space>
      )}
    </Card>
  );
}
