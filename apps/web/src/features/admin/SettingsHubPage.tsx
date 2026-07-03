import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card, Col, Row, Typography } from 'antd';
import {
  TagsOutlined,
  BellOutlined,
  SafetyCertificateOutlined,
  PaperClipOutlined,
  TeamOutlined,
  UserOutlined,
  MailOutlined,
  KeyOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { useMe } from '../../lib/auth';
import { palette } from '../../theme';

const { Title, Text, Paragraph } = Typography;

interface ConfigCard {
  key: string;
  titleKey: string;
  descKey: string;
  path: string;
  icon: React.ReactNode;
  ssaOnly?: boolean;
}
interface Section {
  titleKey: string;
  cards: ConfigCard[];
}

/** Config pages grouped into logical clusters (v1 redesign) so the hub reads as a
 *  small set of areas, not eight loose tiles. Titles reuse each page's nav label. */
const SECTIONS: Section[] = [
  {
    titleKey: 'settings.section.workflow',
    cards: [
      { key: 'categories', titleKey: 'menu.categories', descKey: 'settings.desc.categories', path: '/admin/categories', icon: <TagsOutlined /> },
      { key: 'reminders', titleKey: 'menu.reminders', descKey: 'settings.desc.reminders', path: '/admin/reminders', icon: <BellOutlined /> },
      { key: 'replyTemplates', titleKey: 'tpl.title', descKey: 'settings.desc.replyTemplates', path: '/admin/reply-templates', icon: <MessageOutlined /> },
    ],
  },
  {
    titleKey: 'settings.section.people',
    cards: [
      { key: 'users', titleKey: 'menu.users', descKey: 'settings.desc.users', path: '/admin/users', icon: <UserOutlined /> },
      { key: 'groups', titleKey: 'groups.nav', descKey: 'settings.desc.groups', path: '/admin/groups', icon: <TeamOutlined /> },
      { key: 'roles', titleKey: 'menu.roles', descKey: 'settings.desc.roles', path: '/admin/roles', icon: <KeyOutlined />, ssaOnly: true },
    ],
  },
  {
    titleKey: 'settings.section.system',
    cards: [
      { key: 'mailProtection', titleKey: 'spam.nav.mailProtection', descKey: 'settings.desc.mailProtection', path: '/admin/mail-protection', icon: <SafetyCertificateOutlined /> },
      { key: 'attachments', titleKey: 'files.nav.attachmentConfig', descKey: 'settings.desc.attachments', path: '/admin/attachments', icon: <PaperClipOutlined /> },
      { key: 'emailConnection', titleKey: 'conn.nav', descKey: 'settings.desc.emailConnection', path: '/admin/email-connection', icon: <MailOutlined /> },
    ],
  },
];

/**
 * Story 11.3 + v1 redesign — the aggregate "Settings" hub (Admin/SSA). Config
 * surfaces grouped into Workflow · People & Permissions · System. SSA additionally
 * sees the role-permissions card; the header project switcher applies page-wide.
 */
export function SettingsHubPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const isSsa = me?.role === 'ssa';

  return (
    <div style={{ maxWidth: 1040 }}>
      <Title level={4}>{t('settings.hub.title')}</Title>
      <Paragraph type="secondary">{t('settings.hub.subtitle')}</Paragraph>

      {SECTIONS.map((section) => {
        const cards = section.cards.filter((c) => !c.ssaOnly || isSsa);
        if (cards.length === 0) return null;
        return (
          <div key={section.titleKey} style={{ marginBottom: 28 }}>
            <Text strong style={{ display: 'block', marginBottom: 12, color: '#6B7280', textTransform: 'uppercase', fontSize: 12, letterSpacing: '0.08em' }}>
              {t(section.titleKey)}
            </Text>
            <Row gutter={[16, 16]}>
              {cards.map((c) => (
                <Col key={c.key} xs={24} sm={12} lg={8}>
                  <Card hoverable aria-label={`config-card-${c.key}`} onClick={() => navigate(c.path)} style={{ height: '100%' }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      <span style={{ fontSize: 22, color: palette.primary, lineHeight: 1 }}>{c.icon}</span>
                      <div>
                        <Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>
                          {t(c.titleKey)}
                        </Title>
                        <Text type="secondary">{t(c.descKey)}</Text>
                      </div>
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
          </div>
        );
      })}
    </div>
  );
}
