import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card, Col, Row, Typography } from 'antd';
import { useMe } from '../../lib/auth';

const { Title, Text, Paragraph } = Typography;

interface ConfigCard {
  key: string;
  titleKey: string;
  descKey: string;
  path: string;
  ssaOnly?: boolean;
}

/** The scattered config pages, gathered (Story 11.3 AC3). Titles reuse each page's
 *  existing nav label so they stay in sync. */
const CARDS: ConfigCard[] = [
  { key: 'categories', titleKey: 'menu.categories', descKey: 'settings.desc.categories', path: '/admin/categories' },
  { key: 'reminders', titleKey: 'menu.reminders', descKey: 'settings.desc.reminders', path: '/admin/reminders' },
  { key: 'mailProtection', titleKey: 'spam.nav.mailProtection', descKey: 'settings.desc.mailProtection', path: '/admin/mail-protection' },
  { key: 'attachments', titleKey: 'files.nav.attachmentConfig', descKey: 'settings.desc.attachments', path: '/admin/attachments' },
  { key: 'groups', titleKey: 'groups.nav', descKey: 'settings.desc.groups', path: '/admin/groups' },
  { key: 'users', titleKey: 'menu.users', descKey: 'settings.desc.users', path: '/admin/users' },
  { key: 'emailConnection', titleKey: 'conn.nav', descKey: 'settings.desc.emailConnection', path: '/admin/email-connection' },
  { key: 'roles', titleKey: 'menu.roles', descKey: 'settings.desc.roles', path: '/admin/roles', ssaOnly: true },
];

/**
 * Story 11.3 — the aggregate "Settings" hub (Admin/SSA). A directory of every
 * config surface built across the epics; SSA additionally sees the role-permissions
 * card and the header project switcher applies page-wide (FR93). Admin never sees
 * the SSA-only card. The hard boundary is still each page's RequireRole + the BE.
 */
export function SettingsHubPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const isSsa = me?.role === 'ssa';
  const cards = CARDS.filter((c) => !c.ssaOnly || isSsa);

  return (
    <div style={{ maxWidth: 980 }}>
      <Title level={4}>{t('settings.hub.title')}</Title>
      <Paragraph type="secondary">{t('settings.hub.subtitle')}</Paragraph>
      <Row gutter={[16, 16]}>
        {cards.map((c) => (
          <Col key={c.key} xs={24} sm={12} lg={8}>
            <Card
              hoverable
              aria-label={`config-card-${c.key}`}
              onClick={() => navigate(c.path)}
              style={{ height: '100%' }}
            >
              <Title level={5} style={{ marginTop: 0 }}>
                {t(c.titleKey)}
              </Title>
              <Text type="secondary">{t(c.descKey)}</Text>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
