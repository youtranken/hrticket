import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Descriptions, Tag, Space, Typography, Button, List, Alert, Spin, App as AntApp } from 'antd';
import { useMe } from '../../lib/auth';
import { useTicket, useApproveParticipant, displayCode } from '../../lib/tickets';
import { StatusTag } from '../../components/StatusTag';
import { SafeMessageBody } from '../../components/SafeMessageBody';
import { ComposeBox } from './ComposeBox';
import { AssignControls } from './AssignControls';
import { TagEditor } from './TagEditor';
import i18n from '../../i18n';

const { Title, Text } = Typography;

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function TicketDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { data: me } = useMe();
  const { data, isLoading, isError } = useTicket(id);
  const approve = useApproveParticipant(id);
  const ssa = me?.role === 'ssa';
  const lang = i18n.language === 'en' ? 'en' : 'vi';

  if (isLoading) return <Spin style={{ margin: 80 }} />;
  if (isError || !data) return <Alert type="error" message={t('ticket.notFound')} showIcon />;

  const { ticket, messages, participants, tags, attachments, links } = data;
  const pendingStrangers = participants.filter((p) => p.status === 'pending_approval');

  const act = (participantId: number, action: 'approve' | 'reject') =>
    approve.mutate(
      { participantId, action },
      { onSuccess: () => message.success(t(action === 'approve' ? 'ticket.approved' : 'ticket.rejected')) },
    );

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <a onClick={() => navigate('/inbox')}>← {t('menu.inbox')}</a>

      <Card>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space wrap>
            <Title level={4} style={{ margin: 0 }}>
              {displayCode(ticket.ticketCode, ticket.projectKey, ssa)} · {ticket.subject}
            </Title>
            <StatusTag status={ticket.status} />
          </Space>
          <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
            <Descriptions.Item label={t('ticket.requester')}>{ticket.requesterEmail}</Descriptions.Item>
            <Descriptions.Item label={t('ticket.category')}>
              {ticket.category ? ticket.category[lang] : '—'}
            </Descriptions.Item>
            <Descriptions.Item label={t('ticket.time')}>{vnTime(ticket.createdAt)}</Descriptions.Item>
            <Descriptions.Item label={t('ticket.tags')}>
              <TagEditor ticketId={ticket.id} tags={tags} />
            </Descriptions.Item>
          </Descriptions>
          <AssignControls ticket={ticket} />
          {links.length > 0 && (
            <Space wrap>
              <Text type="secondary">{t('ticket.crossPost')}:</Text>
              {links.map((l) => (
                <Link key={l.id} to={`/tickets/${l.id}`}>
                  <Tag color="orange">{displayCode(l.ticketCode, l.projectKey, true)}</Tag>
                </Link>
              ))}
            </Space>
          )}
        </Space>
      </Card>

      {pendingStrangers.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t('ticket.strangerWarn')}
          description={
            <List
              size="small"
              dataSource={pendingStrangers}
              renderItem={(p) => (
                <List.Item
                  actions={[
                    <Button key="a" size="small" type="primary" onClick={() => act(p.id, 'approve')}>
                      {t('ticket.approve')}
                    </Button>,
                    <Button key="r" size="small" danger onClick={() => act(p.id, 'reject')}>
                      {t('ticket.reject')}
                    </Button>,
                  ]}
                >
                  {p.email}
                </List.Item>
              )}
            />
          }
        />
      )}

      {attachments.length > 0 && (
        <Card size="small" title={t('ticket.attachments')}>
          <Space wrap>
            {attachments.map((a) => (
              <Tag key={a.id} color={a.status === 'stored' ? 'blue' : 'red'}>
                {a.status === 'stored' ? '📎' : '⚠'} {a.fileName} ({humanSize(a.size)})
                {a.status !== 'stored' && ` — ${t('ticket.blocked')}`}
              </Tag>
            ))}
          </Space>
        </Card>
      )}

      {messages.map((m) => (
        <Card
          key={m.id}
          size="small"
          type="inner"
          style={m.isInternal ? { background: '#fffbe6' } : undefined}
          title={
            <Space>
              {m.isInternal ? (
                <Tag color="purple">{t('ticket.internal')}</Tag>
              ) : (
                <Tag color={m.direction === 'inbound' ? 'green' : 'blue'}>{t(`ticket.${m.direction}`)}</Tag>
              )}
              <Text strong>{m.fromAddr}</Text>
              {m.isAutoReply && <Tag>{t('ticket.autoReply')}</Tag>}
              <Text type="secondary">{vnTime(m.createdAt)}</Text>
            </Space>
          }
        >
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            {/* Notes have no recipients; emails show From/To/CC (BCC outbound only, FR8). */}
            {!m.isInternal && m.toAddrs?.length ? <Text type="secondary">To: {m.toAddrs.join(', ')}</Text> : null}
            {!m.isInternal && m.ccAddrs?.length ? <Text type="secondary">Cc: {m.ccAddrs.join(', ')}</Text> : null}
            {m.direction === 'outbound' && !m.isInternal && m.bccAddrs?.length ? (
              <Text type="secondary">Bcc: {m.bccAddrs.join(', ')}</Text>
            ) : null}
            <div style={{ marginTop: 8 }}>
              <SafeMessageBody html={m.bodyHtmlSafe} text={m.bodyText} />
            </div>
          </Space>
        </Card>
      ))}

      <ComposeBox ticketId={id} />
    </Space>
  );
}
