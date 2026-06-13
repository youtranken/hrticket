import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, Form, Input, Typography, App as AntApp } from 'antd';
import { changePassword } from '../../lib/auth';

const { Title, Paragraph } = Typography;

/** Forced password change (must_change_password) and self-service change. */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: forced ? '100vh' : undefined }}>
      <Card style={{ width: 380 }}>
        <Title level={4}>{t('common.password')}</Title>
        {forced && <Paragraph type="warning">Bạn cần đổi mật khẩu trước khi tiếp tục.</Paragraph>}
        <Form
          layout="vertical"
          onFinish={async (v: { currentPassword: string; newPassword: string }) => {
            try {
              await changePassword(v.currentPassword, v.newPassword);
              await qc.invalidateQueries({ queryKey: ['me'] });
              message.success('OK');
              navigate('/');
            } catch {
              message.error('Mật khẩu hiện tại không đúng');
            }
          }}
        >
          <Form.Item name="currentPassword" label="Mật khẩu hiện tại" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="newPassword" label="Mật khẩu mới" rules={[{ required: true, min: 8 }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            {t('common.save')}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
