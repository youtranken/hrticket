import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, Form, Input, Typography, Alert, App as AntApp } from 'antd';
import { changePassword } from '../../lib/auth';
import { AuthBrandPanel } from './AuthBrandPanel';

const { Title } = Typography;

/** Forced password change (must_change_password) and self-service change. */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();

  const form = (
    <Form
      layout="vertical"
      onFinish={async (v: { currentPassword: string; newPassword: string }) => {
        try {
          await changePassword(v.currentPassword, v.newPassword);
          await qc.invalidateQueries({ queryKey: ['me'] });
          message.success(t('common.saved'));
          navigate('/');
        } catch {
          message.error(t('auth.wrongCurrentPassword'));
        }
      }}
    >
      <Form.Item name="currentPassword" label={t('auth.currentPassword')} rules={[{ required: true }]}>
        <Input.Password size="large" />
      </Form.Item>
      <Form.Item name="newPassword" label={t('auth.newPassword')} rules={[{ required: true, min: 8 }]}>
        <Input.Password size="large" />
      </Form.Item>
      <Button type="primary" htmlType="submit" block size="large">
        {t('common.save')}
      </Button>
    </Form>
  );

  // Self-service (inside the app): a plain centered card is enough.
  if (!forced) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <Card style={{ width: 380, maxWidth: '100%' }}>
          <Title level={4} style={{ marginTop: 0 }}>
            {t('auth.changePasswordTitle')}
          </Title>
          {form}
        </Card>
      </div>
    );
  }

  // Forced (first login / reset): full-screen, same brand shell as the login page so
  // it never renders as a blank white sheet.
  return (
    <div className="login-root">
      <div className="login-mobilebar">
        <img src="/logo.png" alt="Phú Mỹ Hưng" />
        <span className="login-mobilebar__title">{t('login.brandTitle')}</span>
      </div>
      <div className="login-split">
        <AuthBrandPanel />
        <div className="login-form">
          <div className="login-card">
            <Title level={3} style={{ marginTop: 0, marginBottom: 8 }}>
              {t('auth.changePasswordTitle')}
            </Title>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={t('auth.mustChangePassword')}
            />
            {form}
          </div>
        </div>
      </div>
    </div>
  );
}
