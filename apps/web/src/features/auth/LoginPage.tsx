import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, Form, Input, Segmented, Typography, App as AntApp } from 'antd';
import { login } from '../../lib/auth';
import { ApiError } from '../../lib/apiClient';
import { setLanguage } from '../../i18n';
import i18n from '../../i18n';

const { Title } = Typography;

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [lang, setLang] = useState(i18n.language === 'en' ? 'en' : 'vi');

  const onFinish = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      const res = await login(values.email, values.password);
      if (res.otpRequired) {
        navigate('/otp', { state: { email: values.email } });
        return;
      }
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(params.get('returnUrl') ?? '/');
    } catch (e) {
      const err = e as ApiError;
      const key =
        err.status === 429
          ? 'login.error.locked'
          : err.status === 403
            ? 'login.error.disabled'
            : 'login.error.invalid';
      message.error(t(key));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <Card style={{ width: 380 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={3} style={{ margin: 0 }}>
            {t('login.heading')}
          </Title>
          <Segmented
            size="small"
            value={lang}
            options={[
              { label: 'VI', value: 'vi' },
              { label: 'EN', value: 'en' },
            ]}
            onChange={(v) => {
              setLang(v as string);
              setLanguage(v as 'vi' | 'en');
            }}
          />
        </div>
        <Form layout="vertical" onFinish={onFinish} style={{ marginTop: 16 }}>
          <Form.Item name="email" label={t('common.email')} rules={[{ required: true, type: 'email' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label={t('common.password')} rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            {t('login.submit')}
          </Button>
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <a onClick={() => navigate('/forgot')}>{t('login.forgot')}</a>
          </div>
        </Form>
      </Card>
    </div>
  );
}
