import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, Input, Typography, App as AntApp } from 'antd';
import { verifyOtp } from '../../lib/auth';

const { Title, Paragraph } = Typography;

export function OtpPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: { preAuthToken?: string; returnUrl?: string } };
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  if (!state?.preAuthToken) return <Navigate to="/login" replace />;

  const submit = async () => {
    setLoading(true);
    try {
      await verifyOtp(state.preAuthToken!, code);
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(state.returnUrl ?? '/');
    } catch {
      message.error(t('login.error.invalid'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <Card style={{ width: 360 }}>
        <Title level={4}>{t('otp.heading')}</Title>
        <Paragraph type="secondary">{t('otp.prompt')}</Paragraph>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          maxLength={6}
          style={{ letterSpacing: 8, textAlign: 'center', fontSize: 20 }}
        />
        <Button type="primary" block style={{ marginTop: 16 }} loading={loading} onClick={submit}>
          {t('otp.submit')}
        </Button>
      </Card>
    </div>
  );
}
