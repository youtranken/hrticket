import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Form, Input, Result, Typography } from 'antd';
import { forgotPassword } from '../../lib/auth';

const { Title } = Typography;

export function ForgotPage() {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Result
          status="info"
          title="Đã gửi (nếu email tồn tại)"
          subTitle="Kiểm tra hộp thư để đặt lại mật khẩu."
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <Card style={{ width: 360 }}>
        <Title level={4}>{t('login.forgot')}</Title>
        <Form
          layout="vertical"
          onFinish={async (v: { email: string }) => {
            await forgotPassword(v.email);
            setSent(true);
          }}
        >
          <Form.Item name="email" label={t('common.email')} rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            {t('common.save')}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
