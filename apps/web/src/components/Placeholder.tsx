import { useTranslation } from 'react-i18next';
import { Empty, Result, Card } from 'antd';

/** Generic "coming soon" placeholder for routes built in later epics. */
export function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <Card title={t(titleKey)}>
      <Empty description={t('common.comingSoon')} />
    </Card>
  );
}

export function ForbiddenPage() {
  const { t } = useTranslation();
  return <Result status="403" title={t('forbidden.title')} subTitle={t('forbidden.desc')} />;
}
