import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Result, Card } from 'antd';
import { EmptyState } from './EmptyState';
import { NoDataArt } from './illustrations/empty';
import { ForbiddenArt, NotFoundArt } from './illustrations/status';

/** Generic "coming soon" placeholder for routes built in later epics. */
export function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <Card title={t(titleKey)}>
      <EmptyState art={<NoDataArt />} description={t('common.comingSoon')} />
    </Card>
  );
}

export function ForbiddenPage() {
  const { t } = useTranslation();
  return (
    <Result
      icon={<ForbiddenArt size={200} />}
      title={t('forbidden.title')}
      subTitle={t('forbidden.desc')}
    />
  );
}

/** Unknown URL — a typo or stale link is a 404, NOT a permission problem: showing
 *  403 here made users think they were blocked. Offers a way back to the inbox. */
export function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Result
      icon={<NotFoundArt size={200} />}
      title={t('notFound.title')}
      subTitle={t('notFound.desc')}
      extra={
        <Button type="primary" onClick={() => navigate('/inbox')}>
          {t('notFound.backToInbox')}
        </Button>
      }
    />
  );
}
