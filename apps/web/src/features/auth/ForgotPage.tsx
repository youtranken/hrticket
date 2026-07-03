import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Form, Input, Result, Typography } from 'antd';
import { forgotPassword } from '../../lib/auth';

const { Title } = Typography;

export function ForgotPage() {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  if (sent) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Result
          status="info"
          title={t('login.forgotSentTitle')}
          subTitle={t('login.forgotSentDesc')}
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
            setLoading(true);
            try {
              await forgotPassword(v.email);
              setSent(true);
            } finally {
              setLoading(false);
            }
          }}
        >
          <Form.Item name="email" label={t('common.email')} rules={[{ required: true, type: 'email' }]}>
            <Input autoFocus type="email" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            {t('login.forgotSubmit')}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
