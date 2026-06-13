import { useTranslation } from 'react-i18next';
import { Card, Typography } from 'antd';
import { useMe } from '../../lib/auth';

const { Title, Paragraph } = Typography;

/** Placeholder landing — replaced by the real AppShell + Sidebar in Story 1.8. */
export function HomePage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  return (
    <div style={{ maxWidth: 640, margin: '64px auto', padding: 24 }}>
      <Card>
        <Title level={3}>{t('app.title')}</Title>
        <Paragraph>
          {me ? `${me.user.name} · ${me.role}` : ''}
        </Paragraph>
        <Paragraph type="secondary">App shell &amp; permission sidebar arrive in Story 1.8.</Paragraph>
      </Card>
    </div>
  );
}
