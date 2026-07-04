import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Form, Input, Segmented, Typography, Result, App as AntApp } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { login, forgotPassword } from '../../lib/auth';
import { AuthBrandPanel } from './AuthBrandPanel';
import { ApiError } from '../../lib/apiClient';
import { setLanguage } from '../../i18n';
import i18n from '../../i18n';

const { Title, Text } = Typography;

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [lang, setLang] = useState(i18n.language === 'en' ? 'en' : 'vi');
  // "Forgot password" swaps the right panel in place (no navigation to a separate
  // page) — login and reset-request share the same split screen.
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [forgotSent, setForgotSent] = useState(false);

  const onFinish = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      const res = await login(values.email, values.password);
      if (res.otpRequired) {
        navigate('/otp', {
          state: { preAuthToken: res.preAuthToken, returnUrl: params.get('returnUrl') },
        });
        return;
      }
      // Actively REFETCH (not just invalidate) and AWAIT it, so the ['me'] cache holds
      // the real user before we navigate. Otherwise the route guard reads the stale
      // `null` cached from the pre-login 401 and bounces straight back to /login —
      // forcing a needless second login (esp. for first-login must-change-password).
      await qc.refetchQueries({ queryKey: ['me'] });
      navigate(params.get('returnUrl') ?? '/');
    } catch (e) {
      const err = e as ApiError;
      // Map by code first so a non-disabled 403 (e.g. PASSWORD_CHANGE_REQUIRED) isn't
      // mislabelled "account disabled" — fall back to the BE's own message for unknowns.
      if (err.status === 429) {
        // Lockout says HOW LONG (P2 #6) — fall back to the vague text if the BE
        // didn't include the window (e.g. OTP resend cap).
        const wait = Number(err.details?.retryAfterSeconds);
        message.error(
          Number.isFinite(wait) && wait > 0
            ? t('login.error.lockedFor', { s: wait })
            : t('login.error.locked'),
        );
        return;
      }
      const key =
        err.code === 'PASSWORD_CHANGE_REQUIRED'
          ? null
          : err.status === 403
            ? 'login.error.disabled'
            : err.status === 401 || err.status === 400
              ? 'login.error.invalid'
              : null;
      message.error(key ? t(key) : err.message);
    } finally {
      setLoading(false);
    }
  };

  // Non-revealing by design: whether or not the address exists, we land on the same
  // "sent" state (the server never confirms account existence).
  const onForgot = async (values: { email: string }) => {
    setLoading(true);
    try {
      await forgotPassword(values.email);
    } catch {
      /* swallow — still show the neutral "sent" screen */
    } finally {
      setLoading(false);
      setForgotSent(true);
    }
  };

  const backToLogin = () => {
    setMode('login');
    setForgotSent(false);
  };

  return (
    <div className="login-root">
      {/* Compact brand bar for tablet/phone — keeps the identity when the big panel is
          hidden (< 992px). Desktop hides this and shows the full panel instead. */}
      <div className="login-mobilebar">
        <img src="/logo.png" alt="Phú Mỹ Hưng" />
        <span className="login-mobilebar__title">{t('login.brandTitle')}</span>
      </div>

      <div className="login-split">
      <AuthBrandPanel />

      {/* Form panel */}
      <div className="login-form">
        <div className="login-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Title level={3} style={{ margin: 0 }}>
              {mode === 'login' ? t('login.heading') : t('login.forgotTitle')}
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

          {mode === 'login' ? (
            <Form layout="vertical" onFinish={onFinish} style={{ marginTop: 16 }}>
              <Form.Item name="email" label={t('common.email')} rules={[{ required: true, type: 'email' }]}>
                <Input autoFocus type="email" inputMode="email" autoComplete="username" size="large" />
              </Form.Item>
              <Form.Item name="password" label={t('common.password')} rules={[{ required: true }]}>
                <Input.Password autoComplete="current-password" size="large" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                {t('login.submit')}
              </Button>
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                {/* Real button, not a bare <a onClick> — reachable by Tab/Enter (#35). */}
                <Button type="link" size="small" onClick={() => setMode('forgot')}>
                  {t('login.forgot')}
                </Button>
              </div>
            </Form>
          ) : forgotSent ? (
            <Result
              style={{ padding: '24px 0' }}
              status="success"
              title={t('login.forgotSentTitle')}
              subTitle={t('login.forgotSentDesc')}
              extra={
                <Button onClick={backToLogin}>
                  <ArrowLeftOutlined style={{ marginInlineEnd: 6 }} />
                  {t('login.backToLogin')}
                </Button>
              }
            />
          ) : (
            <Form layout="vertical" onFinish={onForgot} style={{ marginTop: 16 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                {t('login.forgotHint')}
              </Text>
              <Form.Item name="email" label={t('common.email')} rules={[{ required: true, type: 'email' }]}>
                <Input autoFocus type="email" inputMode="email" autoComplete="username" size="large" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                {t('login.forgotSubmit')}
              </Button>
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <Button type="link" size="small" onClick={backToLogin} icon={<ArrowLeftOutlined />}>
                  {t('login.backToLogin')}
                </Button>
              </div>
            </Form>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
