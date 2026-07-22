import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  LockOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Row,
  Space,
  Tag,
  Typography,
  App as AntApp,
} from 'antd';
import { PageHeader } from '../../components/PageHeader';
import { palette } from '../../theme';
import {
  useEmailConnection,
  useSaveEmailConnection,
  useTestConnection,
  type EmailConnectionInput,
  type TestResult,
} from '../../lib/emailConnection';

const { Text } = Typography;

/** A labelled form field — caption above a full-width control, consistent spacing. */
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

/**
 * Story 11.1 — SSA/Admin "Email connection" page: per-project IMAP/SMTP host/port/
 * user + App Password, with a real "Test connection" that logs in both ways and
 * shows each leg's status Tag + reason. The password is write-only — the field shows
 * the stored mask (`****1234`) and an empty submit keeps it unchanged.
 */
export function EmailConnectionPage() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { data: cfg } = useEmailConnection();
  const save = useSaveEmailConnection();
  const test = useTestConnection();

  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(993);
  const [imapUser, setImapUser] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpUser, setSmtpUser] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (cfg) {
      setImapHost(cfg.imapHost ?? '');
      setImapPort(cfg.imapPort ?? 993);
      setImapUser(cfg.imapUser ?? '');
      setSmtpHost(cfg.smtpHost ?? '');
      setSmtpPort(cfg.smtpPort ?? 465);
      setSmtpUser(cfg.smtpUser ?? '');
      setPassword('');
      setResult(null);
    }
  }, [cfg]);

  const payload = (): EmailConnectionInput => ({
    imapHost: imapHost.trim(),
    imapPort,
    imapUser: imapUser.trim(),
    smtpHost: smtpHost.trim(),
    smtpPort,
    smtpUser: smtpUser.trim(),
    ...(password ? { password } : {}),
  });

  const onSave = () =>
    save.mutate(payload(), {
      onSuccess: () => {
        message.success(t('common.saved'));
        setPassword('');
      },
      onError: (e) => message.error(e.message),
    });

  const onTest = () =>
    test.mutate(payload(), {
      onSuccess: (r) => setResult(r),
      onError: (e) => message.error(e.message),
    });

  const leg = (label: string, ok: boolean, detail?: string) => (
    <Space>
      <Tag
        color={ok ? 'success' : 'error'}
        icon={ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
        style={{ minWidth: 72, textAlign: 'center', marginInlineEnd: 0 }}
      >
        {label}
      </Tag>
      {detail && <Text type={ok ? 'secondary' : 'danger'}>{detail}</Text>}
    </Space>
  );

  return (
    <div style={{ maxWidth: 920, margin: '0 auto' }}>
      <PageHeader title={t('conn.title')} subtitle={t('conn.subtitle')} />

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {cfg?.source === 'env' && <Alert type="info" showIcon message={t('conn.fromEnv')} />}

        <Card
          size="small"
          title={
            <Space>
              <CloudDownloadOutlined style={{ color: palette.primary }} />
              {t('conn.imapTitle')}
            </Space>
          }
        >
          <Row gutter={[16, 12]}>
            <Col xs={24} sm={16}>
              <Field label={t('conn.host')}>
                <Input
                  aria-label="imap-host"
                  value={imapHost}
                  onChange={(e) => setImapHost(e.target.value)}
                  style={{ width: '100%' }}
                />
              </Field>
            </Col>
            <Col xs={24} sm={8}>
              <Field label={t('conn.port')}>
                <InputNumber
                  aria-label="imap-port"
                  min={1}
                  max={65535}
                  value={imapPort}
                  onChange={(v) => setImapPort(v ?? 993)}
                  style={{ width: '100%' }}
                />
              </Field>
            </Col>
            <Col xs={24}>
              <Field label={t('conn.user')}>
                <Input
                  aria-label="imap-user"
                  value={imapUser}
                  onChange={(e) => setImapUser(e.target.value)}
                  style={{ width: '100%' }}
                />
              </Field>
            </Col>
          </Row>
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <CloudUploadOutlined style={{ color: palette.primary }} />
              {t('conn.smtpTitle')}
            </Space>
          }
        >
          <Row gutter={[16, 12]}>
            <Col xs={24} sm={16}>
              <Field label={t('conn.host')}>
                <Input
                  aria-label="smtp-host"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  style={{ width: '100%' }}
                />
              </Field>
            </Col>
            <Col xs={24} sm={8}>
              <Field label={t('conn.port')}>
                <InputNumber
                  aria-label="smtp-port"
                  min={1}
                  max={65535}
                  value={smtpPort}
                  onChange={(v) => setSmtpPort(v ?? 465)}
                  style={{ width: '100%' }}
                />
              </Field>
            </Col>
            <Col xs={24}>
              <Field label={t('conn.user')}>
                <Input
                  aria-label="smtp-user"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  style={{ width: '100%' }}
                />
              </Field>
            </Col>
          </Row>
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <LockOutlined style={{ color: palette.primary }} />
              {t('conn.passwordTitle')}
            </Space>
          }
        >
          <Field label={t('conn.passwordTitle')}>
            <Input.Password
              aria-label="app-password"
              placeholder={cfg?.passwordMask ?? t('conn.passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ maxWidth: 320 }}
            />
          </Field>
          <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
            {t('conn.passwordHint')}
          </Text>
        </Card>

        <Space>
          <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={save.isPending}>
            {t('common.save')}
          </Button>
          <Button icon={<ThunderboltOutlined />} onClick={onTest} loading={test.isPending}>
            {t('conn.test')}
          </Button>
        </Space>

        {result && (
          <Card size="small" title={t('conn.resultTitle')} aria-label="test-result">
            <Space direction="vertical" size="middle">
              {leg(
                'IMAP',
                result.imap.ok,
                result.imap.ok
                  ? t('conn.imapOk', { count: result.imap.messages ?? 0 })
                  : result.imap.error,
              )}
              {leg('SMTP', result.smtp.ok, result.smtp.ok ? t('conn.smtpOk') : result.smtp.error)}
            </Space>
          </Card>
        )}
      </Space>
    </div>
  );
}
