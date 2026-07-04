import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, Form, Input, Result, Typography, App as AntApp } from 'antd';
import { resetPassword } from '../../lib/auth';
import { PasswordCriteria } from './PasswordCriteria';

const { Title } = Typography;

export function ResetPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { message } = AntApp.useApp();
  const token = params.get('token') ?? '';
  const [antForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const pw: string = Form.useWatch('password', antForm) ?? '';

  // P2: a link with no token can never succeed — say so up front, don't let the
  // user type a whole password first.
  if (!token) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Result
          status="warning"
          title={t('auth.resetLinkInvalid')}
          extra={<Button onClick={() => navigate('/login')}>{t('login.backToLogin')}</Button>}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <Card style={{ width: 360 }}>
        <Title level={4}>{t('auth.resetTitle')}</Title>
        <Form
          form={antForm}
          layout="vertical"
          onFinish={async (v: { password: string }) => {
            setSaving(true);
            try {
              await resetPassword(token, v.password);
              message.success(t('auth.passwordResetDone'));
              navigate('/login');
            } catch {
              message.error(t('auth.resetLinkInvalid'));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Form.Item
            name="password"
            label={t('auth.newPassword')}
            rules={[{ required: true, min: 8 }]}
            extra={<PasswordCriteria value={pw} />}
          >
            <Input.Password autoFocus autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label={t('auth.confirmPassword')}
            dependencies={['password']}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator: (_, value: string) =>
                  !value || getFieldValue('password') === value
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('auth.passwordMismatch'))),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={saving}>
            {t('common.save')}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
