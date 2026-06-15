import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Descriptions, Switch, Modal, Input, Typography, App as AntApp, Divider } from 'antd';
import { useMe, toggleOtp } from '../../lib/auth';
import { ChangePasswordPage } from '../auth/ChangePasswordPage';
import { setLanguage } from '../../i18n';
import i18n from '../../i18n';

const { Title } = Typography;

/** Profile (Story 1.5/S3): info, security (OTP + password), language. */
export function ProfilePage() {
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
      message.success('OK');
      setPwModal(false);
      setPw('');
      await refetch();
    } catch {
      message.error('Mật khẩu không đúng');
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <Card>
        <Title level={4}>{t('menu.profile')}</Title>
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label={t('common.email')}>{me.user.email}</Descriptions.Item>
          <Descriptions.Item label={t('common.name')}>{me.user.name}</Descriptions.Item>
          <Descriptions.Item label={t('common.role')}>{me.role}</Descriptions.Item>
        </Descriptions>

        <Divider>{t('profile.security')}</Divider>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {t('profile.otp2fa')}
          <Switch
            onChange={(v) => {
              setNextEnabled(v);
              setPwModal(true);
            }}
          />
        </div>

        <Divider>{t('common.language')}</Divider>
        <Switch
          checkedChildren="EN"
          unCheckedChildren="VI"
          defaultChecked={i18n.language === 'en'}
          onChange={(v) => setLanguage(v ? 'en' : 'vi')}
        />

        <Divider>{t('common.password')}</Divider>
        <ChangePasswordPage />
      </Card>

      <Modal
        open={pwModal}
        title="Xác nhận mật khẩu"
        onOk={confirmToggle}
        onCancel={() => setPwModal(false)}
      >
        <Input.Password value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Mật khẩu" />
      </Modal>
    </div>
  );
}
