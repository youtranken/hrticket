import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, Form, Input, Typography, App as AntApp } from 'antd';
import { resetPassword } from '../../lib/auth';

const { Title } = Typography;

export function ResetPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { message } = AntApp.useApp();
  const token = params.get('token') ?? '';

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <Card style={{ width: 360 }}>
        <Title level={4}>{t('common.password')}</Title>
        <Form
          layout="vertical"
          onFinish={async (v: { password: string }) => {
            try {
              await resetPassword(token, v.password);
              message.success('OK');
              navigate('/login');
            } catch {
              message.error('Liên kết không còn hiệu lực');
            }
          }}
        >
          <Form.Item
            name="password"
            label={t('common.password')}
            rules={[{ required: true, min: 8 }]}
          >
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
