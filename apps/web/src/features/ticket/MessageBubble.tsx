import { useTranslation } from 'react-i18next';
import { Avatar, Space, Tag, Tooltip, Typography } from 'antd';
import type { TicketMessage } from '../../lib/tickets';
import { SafeMessageBody } from '../../components/SafeMessageBody';
import { FileCard } from '../../components/FileCard';
import { palette } from '../../theme';
import { fmtDateTime } from '../../lib/datetime';

const { Text } = Typography;

export interface MessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: string;
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

function vnTime(iso: string): string {
  return fmtDateTime(iso);
}
function initials(addr: string): string {
  return (addr.split('@')[0] || '?').slice(0, 2).toUpperCase();
}

/**
 * One message in the ticket conversation (v1 redesign). An email thread, not a flat
 * card list: inbound (customer) sits left with a green avatar, outbound (agent) sits
 * right on a tinted bubble, and an internal note is a full-width amber block clearly
 * marked "not sent to the customer".
 */
export function MessageBubble({
  m,
  attachments = [],
  ownProjectKey,
  onForward,
}: {
  m: TicketMessage;
  attachments?: MessageAttachment[];
  /** This ticket's project — a message from a cross-post sibling gets a project tag. */
  ownProjectKey?: string;
  /** When set, the bubble offers "Forward" (hidden on notes + cross-post siblings —
   *  a sibling's message id belongs to the OTHER ticket and can't be forwarded here). */
  onForward?: (m: TicketMessage) => void;
}) {
  const { t } = useTranslation();
  // Cross-post merge: mark messages that belong to the OTHER project's linked ticket.
  const foreign =
    m.fromProjectKey && ownProjectKey && m.fromProjectKey !== ownProjectKey
      ? m.fromProjectKey.toUpperCase()
      : null;

  const fileChips =
    attachments.length > 0 ? (
      <Space wrap size="small" style={{ marginTop: 8 }}>
        {attachments.map((a) => (
          <FileCard key={a.id} attachment={a} />
        ))}
      </Space>
    ) : null;

  if (m.isInternal) {
    return (
      <div
        style={{
          borderLeft: '3px solid #E8B11C',
          background: '#FFFBEF',
          borderRadius: 8,
          padding: '12px 16px',
          margin: '6px 0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <Tag color="gold">{t('ticket.internalNote')}</Tag>
          <Text strong>{m.fromAddr}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {vnTime(m.createdAt)}
          </Text>
        </div>
        <SafeMessageBody html={m.bodyHtmlSafe} text={m.bodyText} />
        {fileChips}
      </div>
    );
  }

  const inbound = m.direction === 'inbound';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: inbound ? 'row' : 'row-reverse',
        gap: 10,
        margin: '10px 0',
      }}
    >
      <Avatar size={36} style={{ background: inbound ? '#1F9D6B' : palette.primary, flexShrink: 0 }}>
        {initials(m.fromAddr)}
      </Avatar>
      <div style={{ maxWidth: '80%' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 4,
            flexWrap: 'wrap',
            justifyContent: inbound ? 'flex-start' : 'flex-end',
          }}
        >
          <Text strong>{m.fromAddr}</Text>
          <Tag color={inbound ? 'green' : 'blue'}>{t(`ticket.${m.direction}`)}</Tag>
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
          {onForward && !foreign && (
            <a style={{ fontSize: 12 }} onClick={() => onForward(m)}>
              {t('compose.forwardAction')}
            </a>
          )}
        </div>
        <div
          style={{
            background: inbound ? '#ffffff' : '#EEF3FA',
            border: '1px solid #EAEDF3',
            borderRadius: 10,
            padding: '12px 14px',
          }}
        >
          {m.toAddrs?.length || m.ccAddrs?.length ? (
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
      </div>
    </div>
  );
}
