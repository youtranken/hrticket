import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  Space,
  Tag,
  Typography,
  App as AntApp,
} from 'antd';
import {
  useEmailConnection,
  useSaveEmailConnection,
  useTestConnection,
  type EmailConnectionInput,
  type TestResult,
} from '../../lib/emailConnection';

const { Title, Text } = Typography;

/**
 * Story 11.1 — SSA/Admin "Email connection" page: per-project IMAP/SMTP host/port/
 * user + App Password, with a real "Test connection" that logs in both ways and
 * shows each leg's ✅/❌ + reason. The password is write-only — the field shows the
 * stored mask (`****1234`) and an empty submit keeps it unchanged.
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
        message.success(t('common.save'));
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
      <Tag color={ok ? 'success' : 'error'}>{ok ? '✅' : '❌'} {label}</Tag>
      {detail && <Text type={ok ? 'secondary' : 'danger'}>{detail}</Text>}
    </Space>
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 640 }}>
      <Title level={4}>{t('conn.title')}</Title>

      {cfg?.source === 'env' && (
        <Alert type="info" showIcon message={t('conn.fromEnv')} />
      )}

      <Card title={t('conn.imapTitle')}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <div>
              <Text type="secondary">{t('conn.host')}</Text>
              <Input
                aria-label="imap-host"
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                style={{ width: 280 }}
              />
            </div>
            <div>
              <Text type="secondary">{t('conn.port')}</Text>
              <InputNumber
                aria-label="imap-port"
                min={1}
                max={65535}
                value={imapPort}
                onChange={(v) => setImapPort(v ?? 993)}
                style={{ width: 110, display: 'block' }}
              />
            </div>
          </Space>
          <div>
            <Text type="secondary">{t('conn.user')}</Text>
            <Input
              aria-label="imap-user"
              value={imapUser}
              onChange={(e) => setImapUser(e.target.value)}
              style={{ width: 280 }}
            />
          </div>
        </Space>
      </Card>

      <Card title={t('conn.smtpTitle')}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <div>
              <Text type="secondary">{t('conn.host')}</Text>
              <Input
                aria-label="smtp-host"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                style={{ width: 280 }}
              />
            </div>
            <div>
              <Text type="secondary">{t('conn.port')}</Text>
              <InputNumber
                aria-label="smtp-port"
                min={1}
                max={65535}
                value={smtpPort}
                onChange={(v) => setSmtpPort(v ?? 465)}
                style={{ width: 110, display: 'block' }}
              />
            </div>
          </Space>
          <div>
            <Text type="secondary">{t('conn.user')}</Text>
            <Input
              aria-label="smtp-user"
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              style={{ width: 280 }}
            />
          </div>
        </Space>
      </Card>

      <Card title={t('conn.passwordTitle')}>
        <Input.Password
          aria-label="app-password"
          placeholder={cfg?.passwordMask ?? t('conn.passwordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: 280 }}
        />
        <div style={{ marginTop: 6 }}>
          <Text type="secondary">{t('conn.passwordHint')}</Text>
        </div>
      </Card>

      <Space>
        <Button type="primary" onClick={onSave} loading={save.isPending}>
          {t('common.save')}
        </Button>
        <Button onClick={onTest} loading={test.isPending}>
          {t('conn.test')}
        </Button>
      </Space>

      {result && (
        <Card title={t('conn.resultTitle')} aria-label="test-result">
          <Space direction="vertical">
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
  );
}
