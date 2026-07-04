import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Steps, Card, Segmented, Typography, Spin, Result } from 'antd';
import { CheckCircleOutlined, SyncOutlined, InboxOutlined } from '@ant-design/icons';
import { setLanguage } from '../../i18n';
import i18n from '../../i18n';
import { palette } from '../../theme';

interface StatusData {
  ticketCode: string;
  subject: string;
  status: 'received' | 'in_progress' | 'done';
  createdAt: string;
}

const STEP_INDEX: Record<StatusData['status'], number> = { received: 0, in_progress: 1, done: 2 };

/**
 * Public, no-login status page (#7) reached from the token-signed link in the auto-ack
 * email. Shows only a coarse 3-step progress — Đã tiếp nhận / Đang xử lý / Hoàn tất.
 */
export function PublicStatusPage() {
  const { t } = useTranslation();
  const { token } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // P2 #4: the auto-ack's EN button links with ?lang=en; external requesters have
  // no account, so the language is per-link (plus the toggle below).
  useEffect(() => {
    const l = params.get('lang');
    if ((l === 'en' || l === 'vi') && l !== i18n.language) setLanguage(l);
  }, [params]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/public/ticket-status/${token}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((d: StatusData) => alive && setData(d))
      .catch(() => alive && setError(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [token]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: palette.siderBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <Card style={{ width: '100%', maxWidth: 560, borderRadius: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Segmented
            size="small"
            value={i18n.language === 'en' ? 'en' : 'vi'}
            options={[
              { label: 'VI', value: 'vi' },
              { label: 'EN', value: 'en' },
            ]}
            onChange={(v) => setLanguage(v as 'vi' | 'en')}
          />
        </div>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <img src="/logo.png" alt="Phú Mỹ Hưng" style={{ height: 48, objectFit: 'contain' }} />
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : error || !data ? (
          <Result status="warning" title={t('track.notFound')} subTitle={t('track.notFoundDesc')} />
        ) : (
          <>
            <Typography.Title level={4} style={{ textAlign: 'center', marginBottom: 4 }}>
              {t('track.title')}
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
              {data.ticketCode} — {data.subject}
            </Typography.Paragraph>
            <Steps
              direction="vertical"
              current={STEP_INDEX[data.status]}
              status={data.status === 'done' ? 'finish' : 'process'}
              items={[
                { title: t('track.received'), icon: <InboxOutlined /> },
                { title: t('track.inProgress'), icon: <SyncOutlined /> },
                { title: t('track.done'), icon: <CheckCircleOutlined /> },
              ]}
              style={{ marginTop: 24 }}
            />
            <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginTop: 20, fontSize: 12 }}>
              {t('track.footer')}
            </Typography.Paragraph>
          </>
        )}
      </Card>
    </div>
  );
}
