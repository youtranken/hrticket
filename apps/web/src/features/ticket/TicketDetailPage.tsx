import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  Skeleton,
  FloatButton,
  App as AntApp,
} from 'antd';
import {
  ArrowLeftOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  DeleteOutlined,
  StopOutlined,
  MoreOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useMe } from '../../lib/auth';
import { useTicket, useApproveParticipant, displayCode, type TicketMessage } from '../../lib/tickets';
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
import { palette } from '../../theme';

const { Title, Text } = Typography;

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' (string-split so it's timezone-safe for a bare date). */
function vnDate(d: string): string {
  const [y, m, day] = d.split('-');
  return day && m && y ? `${day}/${m}/${y}` : d;
}

/**
 * Soft accent banner for ticket-state notices (snooze / closed). Replaces the dark
 * AntD `Alert type="info"` — `colorInfo` is the brand navy, which made info alerts
 * read as heavy/dark. A light tinted bg + a colored left rule keeps it calm and on-brand:
 *   - gold  → "on hold / waiting" (Pending)
 *   - slate → neutral status note (Closed)
 */
function StateBanner({ tone, icon, children }: { tone: 'gold' | 'slate'; icon: ReactNode; children: ReactNode }) {
  const s =
    tone === 'gold'
      ? { bg: '#FBF3DC', rule: '#E8B11C', text: palette.primary }
      : { bg: '#EEF2F8', rule: '#8295B4', text: '#3C5578' };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: s.bg,
        borderInlineStart: `4px solid ${s.rule}`,
        borderRadius: 8,
        padding: '10px 14px',
        color: s.text,
        fontWeight: 500,
      }}
    >
      <span style={{ display: 'inline-flex', fontSize: 16, color: s.rule }}>{icon}</span>
      <span>{children}</span>
    </div>
  );
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

  // Forward mode: the bubble's link selects a message, the ComposeBox opens its
  // Forward tab. The compose sits below the thread — bring it into view.
  const [forwardMsg, setForwardMsg] = useState<TicketMessage | null>(null);

  // Skeleton mirrors the real layout (header card + a couple of message bubbles) so
  // the page doesn't jump when data lands — a lone off-center Spin read as broken.
  if (isLoading) {
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card>
          <Skeleton active title paragraph={{ rows: 3 }} />
        </Card>
        <Card>
          <Skeleton avatar active paragraph={{ rows: 2 }} />
          <Skeleton avatar active paragraph={{ rows: 2 }} style={{ marginTop: 16 }} />
        </Card>
      </Space>
    );
  }
  if (isError || !data) return <Alert type="error" message={t('ticket.notFound')} showIcon />;

  const { ticket, messages, participants, tags, attachments, links } = data;
  const pendingStrangers = participants.filter((p) => p.status === 'pending_approval');

  // Who may TAG / mark spam on this ticket: the assignee, the group's TL, or Admin/SSA —
  // and never on a closed ticket. Other members can only view (the server also enforces).
  const inGroup = ticket.categoryId !== null && (me?.groups ?? []).includes(ticket.categoryId);
  const isAdmin = me?.role === 'ssa' || me?.role === 'admin';
  const canAct =
    isAdmin || ticket.assignee?.id === me?.user.id || (me?.role === 'team_lead' && inGroup);
  // Cross-post no longer locks a side — both projects work their own ticket, each
  // mailing from its own mailbox, and the thread below merges both conversations.
  const canEdit = canAct && ticket.status !== 'closed';
  // Junk / spam-thread → the ticket is "set aside": its manual tags are hidden and the
  // title is dimmed/struck so it's recognisable at a glance (the Rác/Spam badge stays).
  const flagged = !!ticket.isJunk || !!ticket.isSpamThread;

  // Attachments belong to a specific message (inbound or outbound reply) → show them in
  // the thread next to that message. Anything not linked to a message (legacy) stays in
  // the ticket-level card so nothing is hidden.
  const attByMsg = new Map<string, typeof attachments>();
  const orphanAtt: typeof attachments = [];
  for (const a of attachments) {
    if (a.messageId) {
      const list = attByMsg.get(a.messageId) ?? [];
      list.push(a);
      attByMsg.set(a.messageId, list);
    } else {
      orphanAtt.push(a);
    }
  }

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
            <Title
              level={4}
              style={{
                margin: 0,
                fontWeight: 700, // make the ticket subject stand out as the page's headline
                ...(flagged ? { color: '#9ba4b5', textDecoration: 'line-through' } : {}),
              }}
            >
              {displayCode(ticket.ticketCode, ticket.projectKey, ssa)} · {ticket.subject}
            </Title>
            <StatusTag status={ticket.status} />
            {ticket.reopenCount > 0 && ticket.status !== 'closed' && (
              <Tag color="volcano">{t('lifecycle.reopened')}</Tag>
            )}
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
            {/* Spam/junk actions are a handling action → only the assignee / TL / Admin,
                and not on a closed ticket. */}
            {canEdit && (
              <SpamActionsMenu
                ticketId={ticket.id}
                requesterEmail={ticket.requesterEmail}
                isSpamThread={!!ticket.isSpamThread}
                isJunk={!!ticket.isJunk}
              />
            )}
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
              {flagged ? (
                <Text type="secondary">—</Text>
              ) : (
                <TagEditor ticketId={ticket.id} tags={tags} canEdit={canEdit} />
              )}
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
        <StateBanner tone="gold" icon={<ClockCircleOutlined />}>
          {t('lifecycle.snoozedUntil', { date: vnDate(ticket.snoozeUntil) })}
        </StateBanner>
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

      {orphanAtt.length > 0 && (
        <Card size="small" title={t('ticket.attachments')}>
          <Space wrap size="middle">
            {orphanAtt.map((a) => (
              <FileCard key={a.id} attachment={a} />
            ))}
          </Space>
        </Card>
      )}

      <div>
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            m={m}
            attachments={attByMsg.get(m.id) ?? []}
            ownProjectKey={ticket.projectKey}
            onForward={
              // Mirror the server reply gate (review #7): assignee (any role, đơn 5)
              // or TL of the ticket's group — nobody else gets a dead Forward link.
              ticket.status !== 'closed' &&
              me &&
              (ticket.assignee?.id === me.user.id ||
                (me.role === 'team_lead' &&
                  ticket.categoryId !== null &&
                  (me.groups ?? []).includes(ticket.categoryId)))
                ? (msg) => {
                    setForwardMsg(msg);
                    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
                  }
                : undefined
            }
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {ticket.status === 'closed' ? (
        <StateBanner tone="slate" icon={<CheckCircleOutlined />}>
          {t('lifecycle.closedBanner')}
        </StateBanner>
      ) : (
        <ComposeBox
          key={id}
          ticketId={id}
          status={ticket.status}
          forward={forwardMsg}
          onForwardDone={() => setForwardMsg(null)}
        />
      )}

      {/* Quick jump back to the top of a long thread (#9) — branded navy pill with a tooltip. */}
      <FloatButton.BackTop
        visibilityHeight={300}
        type="primary"
        icon={<UpOutlined />}
        tooltip={t('common.backToTop')}
        style={{ insetInlineEnd: 28, insetBlockEnd: 28 }}
      />
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
