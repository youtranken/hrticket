import { useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Descriptions,
  Tag,
  Space,
  Typography,
  Button,
  Dropdown,
  Checkbox,
  List,
  Alert,
  Spin,
  App as AntApp,
} from 'antd';
import {
  ArrowLeftOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  DeleteOutlined,
  StopOutlined,
  MoreOutlined,
} from '@ant-design/icons';
import { useMe } from '../../lib/auth';
import { useTicket, useApproveParticipant, displayCode } from '../../lib/tickets';
import { useMarkJunk, useToggleSpamThread } from '../../lib/junk';
import { StatusTag } from '../../components/StatusTag';
import { MessageBubble } from './MessageBubble';
import { ComposeBox } from './ComposeBox';
import { AssignControls } from './AssignControls';
import { LifecycleControls } from './LifecycleControls';
import { TagEditor } from './TagEditor';
import { FileCard } from '../../components/FileCard';
import { REOPEN_WARN_THRESHOLD } from '@hris/shared';
import i18n from '../../i18n';

const { Title, Text } = Typography;

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
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

  // Long threads (chat convention): jump to the newest message on load so the user isn't
  // stranded at the top. Short tickets stay put so the request + info stay in view.
  const bottomRef = useRef<HTMLDivElement>(null);
  const msgCount = data?.messages.length ?? 0;
  useEffect(() => {
    if (msgCount > 4) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [msgCount]);

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
      <Button
        type="link"
        icon={<ArrowLeftOutlined />}
        style={{ paddingLeft: 0, alignSelf: 'flex-start' }}
        onClick={() => navigate('/inbox')}
      >
        {t('menu.inbox')}
      </Button>

      <Card>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space wrap>
            <Title level={4} style={{ margin: 0 }}>
              {displayCode(ticket.ticketCode, ticket.projectKey, ssa)} · {ticket.subject}
            </Title>
            <StatusTag status={ticket.status} />
            {ticket.reopenCount > 0 && <Tag color="volcano">{t('lifecycle.reopened')}</Tag>}
            {ticket.reopenLocked && (
              <Tag color="red" icon={<LockOutlined />}>
                {t('lifecycle.lockReopen')}
              </Tag>
            )}
            {ticket.categorySensitive && (
              <Tag color="red" icon={<SafetyCertificateOutlined />}>
                {t('ticket.sensitive')}
              </Tag>
            )}
            {ticket.isJunk && (
              <Tag color="default" icon={<DeleteOutlined />}>
                {t('spam.mark.junkBadge')}
              </Tag>
            )}
            {ticket.isSpamThread && (
              <Tag color="gold" icon={<StopOutlined />}>
                {t('spam.mark.spamBadge')}
              </Tag>
            )}
            {ticket.isOverdue && (
              <Tag color="error">{t('lifecycle.overdueDays', { count: ticket.overdueDays })}</Tag>
            )}
            <SpamActionsMenu
              ticketId={ticket.id}
              requesterEmail={ticket.requesterEmail}
              isSpamThread={!!ticket.isSpamThread}
              isJunk={!!ticket.isJunk}
            />
            {me && me.role !== 'member' && (
              <Link to={`/audit?ticketId=${ticket.id}`}>{t('audit.ticketHistory')}</Link>
            )}
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
          {/* Unified action toolbar (v1 redesign) — claim/assign/category + status/lock
              grouped into one bar instead of two loose rows. */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
              padding: '10px 12px',
              background: '#F7F8FB',
              border: '1px solid #EAEDF3',
              borderRadius: 10,
            }}
          >
            <AssignControls ticket={ticket} />
            <LifecycleControls ticket={ticket} />
          </div>
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

      {ticket.isOverdue && (
        <Alert type="error" showIcon message={t('lifecycle.overdueBanner', { count: ticket.overdueDays })} />
      )}
      {ticket.reopenCount > REOPEN_WARN_THRESHOLD && !ticket.reopenLocked && (
        <Alert type="warning" showIcon message={t('lifecycle.reopenWarn', { count: ticket.reopenCount })} />
      )}
      {ticket.status === 'pending' && ticket.snoozeUntil && (
        <Alert type="info" showIcon message={t('lifecycle.snoozedUntil', { date: ticket.snoozeUntil })} />
      )}

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
          <Space wrap size="middle">
            {attachments.map((a) => (
              <FileCard key={a.id} attachment={a} />
            ))}
          </Space>
        </Card>
      )}

      <div>
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      {ticket.status === 'closed' ? (
        <Alert type="info" showIcon message={t('lifecycle.closedBanner')} />
      ) : (
        <ComposeBox key={id} ticketId={id} status={ticket.status} />
      )}
    </Space>
  );
}

/**
 * The "⋮" menu for the two manual spam actions (Story 7.4): "Đánh dấu Rác" (close +
 * isolate, with an optional "block sender" checkbox) and "Đánh dấu Spam thread" (toggle
 * silent-follow). Distinct icons + descriptions so the two can't be confused (AC4).
 * Permission is enforced server-side (403); the menu is shown to everyone and the
 * action reports the error if disallowed.
 */
function SpamActionsMenu({
  ticketId,
  requesterEmail,
  isSpamThread,
  isJunk,
}: {
  ticketId: string;
  requesterEmail: string;
  isSpamThread: boolean;
  isJunk: boolean;
}) {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const markJunk = useMarkJunk();
  const toggleSpam = useToggleSpamThread();

  const onMarkJunk = () => {
    let block = false;
    modal.confirm({
      title: t('spam.mark.junkTitle'),
      icon: null,
      content: (
        <Space direction="vertical">
          <Text>{t('spam.mark.junkConfirm', { email: requesterEmail })}</Text>
          <Checkbox onChange={(e) => (block = e.target.checked)}>
            {t('spam.mark.blockToo')}
          </Checkbox>
        </Space>
      ),
      okButtonProps: { danger: true },
      onOk: () =>
        markJunk
          .mutateAsync({ id: ticketId, blockSender: block })
          .then((r) =>
            message.success(r.blocked ? t('spam.mark.junkedBlocked') : t('spam.mark.junked')),
          )
          .catch((e: Error) => message.error(e.message)),
    });
  };

  const onToggleSpam = () => {
    const next = !isSpamThread;
    toggleSpam.mutate(
      { id: ticketId, on: next },
      {
        onSuccess: () => message.success(next ? t('spam.mark.spamOn') : t('spam.mark.spamOff')),
        onError: (e) => message.error(e.message),
      },
    );
  };

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: [
          {
            key: 'junk',
            icon: <DeleteOutlined />,
            label: t('spam.mark.junkAction'),
            disabled: isJunk,
            onClick: onMarkJunk,
          },
          {
            key: 'spam',
            icon: <StopOutlined />,
            label: isSpamThread ? t('spam.mark.spamActionOff') : t('spam.mark.spamActionOn'),
            onClick: onToggleSpam,
          },
        ],
      }}
    >
      <Button size="small" icon={<MoreOutlined />} aria-label={t('spam.mark.menuLabel')} />
    </Dropdown>
  );
}
