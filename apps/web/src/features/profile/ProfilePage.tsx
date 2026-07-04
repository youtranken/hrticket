import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Card, Descriptions, Switch, Modal, Input, Typography, App as AntApp, Divider } from 'antd';
import { useMe, toggleOtp } from '../../lib/auth';
import { ChangePasswordPage } from '../auth/ChangePasswordPage';

const { Title } = Typography;

/**
 * Profile content (Story 1.5/S3): info + security (OTP + password). Language is NOT
 * here — it lives in the header avatar menu, so duplicating it would be confusing.
 * Rendered both as a full page (/profile) and inside the header popup (ProfileModal).
 */
export function ProfileContent() {
  const { t } = useTranslation();
  const { data: me, refetch } = useMe();
  const { message } = AntApp.useApp();
  const [pwModal, setPwModal] = useState(false);
  const [pw, setPw] = useState('');
  const [nextEnabled, setNextEnabled] = useState(false);
  if (!me) return null;

  const confirmToggle = async () => {
    try {
      await toggleOtp(nextEnabled, pw);
      message.success(t('common.saved'));
      setPwModal(false);
      setPw('');
      await refetch();
    } catch {
      message.error(t('profile.wrongPassword'));
    }
  };

  return (
    <>
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label={t('common.email')}>{me.user.email}</Descriptions.Item>
        <Descriptions.Item label={t('common.name')}>{me.user.name}</Descriptions.Item>
        <Descriptions.Item label={t('common.role')}>{t(`role.${me.role}`)}</Descriptions.Item>
      </Descriptions>

      <Divider>{t('profile.security')}</Divider>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {t('profile.otp2fa')}
        {/* Controlled by the server state: the switch only flips after the password
            confirm succeeds and /me refetches — cancelling leaves it untouched. */}
        <Switch
          checked={me.otpEnabled}
          onChange={(v) => {
            setNextEnabled(v);
            setPwModal(true);
          }}
        />
      </div>

      <Divider>{t('common.password')}</Divider>
      <ChangePasswordPage />

      <Modal
        open={pwModal}
        title={t('profile.confirmPassword')}
        onOk={confirmToggle}
        onCancel={() => {
          setPwModal(false);
          setPw('');
        }}
      >
        {/* P2: turning 2FA OFF is a security downgrade — say so before the password. */}
        {nextEnabled === false && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('profile.otpOffWarn')} />
        )}
        <Input.Password value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t('common.password')} />
      </Modal>
    </>
  );
}

/** Header avatar menu opens this popup instead of routing to a separate page. */
export function ProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onCancel={onClose} footer={null} title={t('menu.profile')} width={560}>
      <ProfileContent />
    </Modal>
  );
}

/** Standalone /profile route (kept for deep links). */
export function ProfilePage() {
  const { t } = useTranslation();
  return (
    <div style={{ maxWidth: 720 }}>
      <Card>
        <Title level={4}>{t('menu.profile')}</Title>
        <ProfileContent />
      </Card>
    </div>
  );
}
