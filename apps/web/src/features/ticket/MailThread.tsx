import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, Space, Tag, Tooltip, Typography } from 'antd';
import {
  DownOutlined,
  PaperClipOutlined,
  SendOutlined,
  EnterOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { TicketMessage } from '../../lib/tickets';
import { SafeMessageBody } from '../../components/SafeMessageBody';
import { FileCard } from '../../components/FileCard';
import { palette } from '../../theme';
import { fmtDateTime } from '../../lib/datetime';

const { Text } = Typography;

/** Threads with this many messages or fewer stay fully expanded; longer ones collapse
 *  all but the newest so the reader isn't forced to scroll past old mail. */
const AUTO_COLLAPSE_OVER = 4;

export interface MessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: string;
}

function vnTime(iso: string): string {
  return fmtDateTime(iso);
}
function initials(addr: string): string {
  return (addr.split('@')[0] || '?').slice(0, 2).toUpperCase();
}

/** One-line preview for a collapsed row: strip HTML/quoted tail, squeeze whitespace. */
function snippet(m: TicketMessage): string {
  const raw = m.bodyText ?? (m.bodyHtmlSafe ?? '').replace(/<[^>]+>/g, ' ');
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/** A labelled row of recipient chips (To / Cc / Bcc) — scannable vs a comma blob. */
function AddrRow({ label, addrs }: { label: string; addrs: string[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      {addrs.map((a) => (
        <Tag key={a} style={{ margin: 0, fontSize: 11 }}>
          {a}
        </Tag>
      ))}
    </div>
  );
}

/**
 * Gmail-style conversation: messages stacked oldest→newest, full width (not the old
 * left/right chat). Older messages collapse to a single line (sender · snippet · time)
 * so a long thread doesn't force endless scrolling; the newest message stays expanded.
 * Click any row to expand/collapse, or use the "expand all / collapse all" toggle.
 */
export function MailThread({
  messages,
  attByMsg,
  ownProjectKey,
  onForward,
  onReply,
}: {
  messages: TicketMessage[];
  attByMsg: Map<string, MessageAttachment[]>;
  ownProjectKey?: string;
  onForward?: (m: TicketMessage) => void;
  onReply?: (m: TicketMessage, mode: 'reply' | 'replyAll') => void;
}) {
  const { t } = useTranslation();
  const lastId = messages.at(-1)?.id;

  // Short threads stay fully open — collapsing helps only once a conversation is long
  // ("nhiều mail thì thu gọn"). Past the threshold we open just the newest (Gmail) and
  // fold the older mail to one line each. User toggles are kept; a freshly-arrived reply
  // becomes the latest and re-opens (effect below).
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    messages.length <= AUTO_COLLAPSE_OVER
      ? new Set(messages.map((m) => m.id))
      : new Set(lastId ? [lastId] : []),
  );
  useEffect(() => {
    if (lastId) setExpanded((prev) => (prev.has(lastId) ? prev : new Set(prev).add(lastId)));
  }, [lastId]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOpen = messages.length > 0 && messages.every((m) => expanded.has(m.id));
  const setAll = (open: boolean) => setExpanded(open ? new Set(messages.map((m) => m.id)) : new Set());

  return (
    <div
      style={{
        border: '1px solid #EAEDF3',
        borderRadius: 12,
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      {messages.length > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '6px 12px',
            background: '#F7F8FB',
            borderBottom: '1px solid #EAEDF3',
          }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('ticket.messageCount', { count: messages.length })}
          </Text>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setAll(!allOpen)}>
            {allOpen ? t('ticket.collapseAll') : t('ticket.expandAll')}
          </Button>
        </div>
      )}
      {messages.map((m, i) => (
        <MailRow
          key={m.id}
          m={m}
          first={i === 0}
          attachments={attByMsg.get(m.id) ?? []}
          expanded={expanded.has(m.id)}
          onToggle={() => toggle(m.id)}
          ownProjectKey={ownProjectKey}
          onForward={onForward}
          onReply={onReply}
        />
      ))}
    </div>
  );
}

function MailRow({
  m,
  first,
  attachments,
  expanded,
  onToggle,
  ownProjectKey,
  onForward,
  onReply,
}: {
  m: TicketMessage;
  first: boolean;
  attachments: MessageAttachment[];
  expanded: boolean;
  onToggle: () => void;
  ownProjectKey?: string;
  onForward?: (m: TicketMessage) => void;
  onReply?: (m: TicketMessage, mode: 'reply' | 'replyAll') => void;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);

  // Cross-post merge: mark messages that belong to the OTHER project's linked ticket.
  const foreign =
    m.fromProjectKey && ownProjectKey && m.fromProjectKey !== ownProjectKey
      ? m.fromProjectKey.toUpperCase()
      : null;
  const inbound = m.direction === 'inbound';
  const hasAtt = attachments.length > 0;

  const fileChips = hasAtt ? (
    <Space wrap size="small" style={{ marginTop: 8 }}>
      {attachments.map((a) => (
        <FileCard key={a.id} attachment={a} />
      ))}
    </Space>
  ) : null;

  // Left accent so direction still reads at a glance without the old left/right layout:
  // internal note = amber, inbound (customer) = green, outbound (agent) = navy.
  const accent = m.isInternal ? '#E8B11C' : inbound ? '#1F9D6B' : palette.primary;
  const avatarBg = m.isInternal ? '#E8B11C' : inbound ? '#1F9D6B' : palette.primary;

  const border = first ? undefined : '1px solid #EFF1F5';

  // ---- Collapsed: a single scannable row ----------------------------------
  if (!expanded) {
    return (
      <div
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          borderTop: border,
          cursor: 'pointer',
          background: hover ? '#F7F8FB' : undefined,
        }}
      >
        <Avatar size={30} style={{ background: avatarBg, flexShrink: 0, fontSize: 12 }}>
          {initials(m.fromAddr)}
        </Avatar>
        <Text strong style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
          {m.fromAddr}
        </Text>
        {m.isInternal && (
          <Tag color="gold" style={{ margin: 0 }}>
            {t('ticket.internal')}
          </Tag>
        )}
        <Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
          {snippet(m)}
        </Text>
        {hasAtt && <PaperClipOutlined style={{ color: '#8C97A8', flexShrink: 0 }} />}
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {vnTime(m.createdAt)}
        </Text>
      </div>
    );
  }

  // ---- Expanded: full message --------------------------------------------
  return (
    <div
      style={{
        borderTop: border,
        borderLeft: `3px solid ${accent}`,
        background: m.isInternal ? '#FFFBEF' : '#fff',
        padding: '12px 16px',
      }}
    >
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          flexWrap: 'wrap',
          cursor: 'pointer',
        }}
      >
        <Avatar size={34} style={{ background: avatarBg, flexShrink: 0 }}>
          {initials(m.fromAddr)}
        </Avatar>
        <Text strong>{m.fromAddr}</Text>
        {m.isInternal ? (
          <Tag color="gold">{t('ticket.internal')}</Tag>
        ) : (
          <Tag color={inbound ? 'green' : 'blue'}>{t(`ticket.${m.direction}`)}</Tag>
        )}
        {foreign && (
          <Tooltip title={t('crossPost.fromSibling', { project: foreign })}>
            <Tag color="orange">{foreign}</Tag>
          </Tooltip>
        )}
        {m.isAutoReply && (
          <Tooltip title={t('ticket.autoReplyHint')}>
            <Tag>{t('ticket.autoReply')}</Tag>
          </Tooltip>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          {vnTime(m.createdAt)}
        </Text>
        <span style={{ flex: 1 }} />
        {/* 12.4: per-message Reply / Reply All (Forward already existed). Same gate as
            Forward (onReply set only when the viewer may reply). */}
        {onReply && !foreign && !m.isInternal && (
          <>
            <Button
              size="small"
              icon={<EnterOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onReply(m, 'reply');
              }}
              style={{ fontSize: 13, borderRadius: 8 }}
            >
              {/* kept English like Forward (compose.replyAction = "Reply" in both locales) */}
              {t('compose.replyAction')}
            </Button>
            <Button
              size="small"
              icon={<TeamOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onReply(m, 'replyAll');
              }}
              style={{ fontSize: 13, borderRadius: 8 }}
            >
              {t('compose.replyAllAction')}
            </Button>
          </>
        )}
        {onForward && !foreign && !m.isInternal && (
          <Button
            size="small"
            icon={<SendOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              onForward(m);
            }}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: palette.primary,
              background: `${palette.primary}14`, // ~8% navy tint highlight
              borderColor: `${palette.primary}40`,
              borderRadius: 8,
            }}
          >
            {t('compose.forwardAction')}
          </Button>
        )}
        <DownOutlined style={{ fontSize: 11, color: '#8C97A8' }} />
      </div>

      {!m.isInternal && (m.toAddrs?.length || m.ccAddrs?.length) ? (
        <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed #EAEDF3' }}>
          {m.toAddrs?.length ? <AddrRow label={t('ticket.field.toLabel')} addrs={m.toAddrs} /> : null}
          {m.ccAddrs?.length ? <AddrRow label={t('ticket.field.ccLabel')} addrs={m.ccAddrs} /> : null}
          {!inbound && m.bccAddrs?.length ? (
            <AddrRow label={t('ticket.field.bccLabel')} addrs={m.bccAddrs} />
          ) : null}
        </div>
      ) : null}

      <SafeMessageBody html={m.bodyHtmlSafe} text={m.bodyText} />
      {fileChips}
    </div>
  );
}
