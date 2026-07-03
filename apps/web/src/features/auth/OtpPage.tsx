import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Input, Typography, App as AntApp } from 'antd';
import { verifyOtp, resendOtp } from '../../lib/auth';
import { AuthBrandPanel } from './AuthBrandPanel';

const { Title, Paragraph } = Typography;

const RESEND_COOLDOWN_S = 60;

export function OtpPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: { preAuthToken?: string; returnUrl?: string } };
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  // Resend returns a FRESH pre-auth token — keep the live one in state so the next
  // verify uses it (the router state's token dies with the old code).
  const [token, setToken] = useState(state?.preAuthToken);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  if (!token) return <Navigate to="/login" replace />;

  const submit = async () => {
    setLoading(true);
    try {
      await verifyOtp(token, code);
      await qc.refetchQueries({ queryKey: ['me'] });
      navigate(state?.returnUrl ?? '/');
    } catch {
      message.error(t('otp.error.invalid'));
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    try {
      setToken(await resendOtp(token));
      setCode('');
      setCooldown(RESEND_COOLDOWN_S);
      message.success(t('otp.resent'));
    } catch (e) {
      message.error((e as Error).message || t('otp.error.invalid'));
    }
  };

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
            <Title level={3} style={{ marginTop: 0 }}>
              {t('otp.heading')}
            </Title>
            <Paragraph type="secondary">{t('otp.prompt')}</Paragraph>
            <Input
              size="large"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onPressEnter={submit}
              maxLength={6}
              autoFocus
              inputMode="numeric"
              style={{ letterSpacing: 10, textAlign: 'center', fontSize: 22, fontWeight: 600 }}
            />
            <Button
              type="primary"
              block
              size="large"
              style={{ marginTop: 16 }}
              loading={loading}
              disabled={code.length < 6}
              onClick={submit}
            >
              {t('otp.submit')}
            </Button>
            <Button type="link" block style={{ marginTop: 8 }} disabled={cooldown > 0} onClick={resend}>
              {cooldown > 0 ? t('otp.resendIn', { s: cooldown }) : t('otp.resend')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
