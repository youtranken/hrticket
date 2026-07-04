import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, Form, Input, Typography, Alert, App as AntApp } from 'antd';
import { changePassword } from '../../lib/auth';
import { ApiError } from '../../lib/apiClient';
import { AuthBrandPanel } from './AuthBrandPanel';
import { PasswordCriteria } from './PasswordCriteria';

const { Title } = Typography;

/**
 * Forced password change (must_change_password) and self-service change (embedded
 * in the Profile page). Self-service STAYS in place on success (#38 — no hard
 * navigate('/') context jump); the forced flow continues into the app.
 */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [antForm] = Form.useForm();
  const newPw: string = Form.useWatch('newPassword', antForm) ?? '';

  const form = (
    <Form
      form={antForm}
      layout="vertical"
      onFinish={async (v: { currentPassword: string; newPassword: string }) => {
        try {
          await changePassword(v.currentPassword, v.newPassword);
          await qc.invalidateQueries({ queryKey: ['me'] });
          message.success(t('common.saved'));
          antForm.resetFields();
          if (forced) navigate('/');
        } catch (e) {
          // Map by status (#37): 401 = wrong current password, 400 = the new one
          // failed the BE policy — not the same fix, so not the same message.
          const err = e as ApiError;
          message.error(
            err.status === 401
              ? t('auth.wrongCurrentPassword')
              : err.status === 400
                ? t('auth.weakNewPassword')
                : err.message,
          );
        }
      }}
    >
      <Form.Item name="currentPassword" label={t('auth.currentPassword')} rules={[{ required: true }]}>
        <Input.Password size="large" autoComplete="current-password" />
      </Form.Item>
      <Form.Item
        name="newPassword"
        label={t('auth.newPassword')}
        rules={[{ required: true, min: 8 }]}
        extra={<PasswordCriteria value={newPw} />}
      >
        <Input.Password size="large" autoComplete="new-password" />
      </Form.Item>
      <Form.Item
        name="confirmPassword"
        label={t('auth.confirmPassword')}
        dependencies={['newPassword']}
        rules={[
          { required: true },
          ({ getFieldValue }) => ({
            validator: (_, value: string) =>
              !value || getFieldValue('newPassword') === value
                ? Promise.resolve()
                : Promise.reject(new Error(t('auth.passwordMismatch'))),
          }),
        ]}
      >
        <Input.Password size="large" autoComplete="new-password" />
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
