import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Dropdown, Empty, List, Typography } from 'antd';
import {
  BellOutlined,
  InboxOutlined,
  RedoOutlined,
  RollbackOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  WarningOutlined,
  HddOutlined,
} from '@ant-design/icons';
import { palette } from '../../theme';
import {
  useNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  type NotificationItem,
} from '../../lib/notifications';
import { fmtDateTime } from '../../lib/datetime';

const { Text } = Typography;

/** A proper AntD icon (not an emoji) per notification type — keeps the dropdown
 *  scannable and renders consistently across OS/browsers. */
function glyph(type: string): { node: React.ReactNode; color: string } {
  if (type.startsWith('ticket_assigned')) return { node: <InboxOutlined />, color: palette.primary };
  if (type.startsWith('ticket_reassigned') || type === 'ticket_resumed') return { node: <RedoOutlined />, color: palette.primary };
  if (type === 'ticket_reopened' || type === 'ticket_reopened_pool') return { node: <RollbackOutlined />, color: '#D97706' };
  if (type === 'snooze_due') return { node: <ClockCircleOutlined />, color: '#D97706' };
  if (type === 'disk_low') return { node: <HddOutlined />, color: '#D14343' };
  if (type === 'mail_bomb') return { node: <WarningOutlined />, color: '#D14343' };
  if (type === 'worker_alert' || type === 'worker_down' || type.endsWith('_failed'))
    return { node: <ExclamationCircleOutlined />, color: '#D14343' };
  return { node: <BellOutlined />, color: '#8c8c8c' };
}

function vnTime(iso: string): string {
  return fmtDateTime(iso);
}

/** Header notification bell with unread badge + dropdown list (Story 6.1). */
export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const [open, setOpen] = useState(false);

  const items = data?.items ?? [];
  const unread = data?.unreadCount ?? 0;

  const onClickItem = (n: NotificationItem) => {
    if (!n.readAt) markRead.mutate(n.id);
    setOpen(false);
    if (n.payload?.ticketId) navigate(`/tickets/${n.payload.ticketId}`);
  };

  // Pass the whole payload into i18n so type-specific keys can interpolate (e.g. the
  // mail-bomb sender); append a ticket code / actor when present.
  const label = (n: NotificationItem): string => {
    const base = t(`notif.${n.type}`, { defaultValue: t('notif.generic'), ...(n.payload ?? {}) });
    const code = n.payload?.ticketCode ? ` ${n.payload.ticketCode}` : '';
    const by = n.payload?.by ? ` · ${n.payload.by}` : '';
    return `${base}${code}${by}`.trim();
  };

  const panel = (
    <div style={{ width: 360, background: '#fff', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.15)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px' }}>
        <Text strong>{t('notif.title')}</Text>
        {unread > 0 && (
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => markAll.mutate()}>
            {t('notif.markAll')}
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notif.empty')} style={{ padding: 16 }} />
      ) : (
        <List
          size="small"
          dataSource={items}
          style={{ maxHeight: 420, overflowY: 'auto' }}
          renderItem={(n) => {
            const g = glyph(n.type);
            return (
              <List.Item
                onClick={() => onClickItem(n)}
                // Keyboard path: a List.Item is a plain div — without these it is
                // unreachable by Tab and unreadable as actionable by screen readers.
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClickItem(n);
                  }
                }}
                style={{ cursor: 'pointer', padding: '8px 12px', background: n.readAt ? undefined : '#e6f4ff' }}
              >
                <List.Item.Meta
                  avatar={<span style={{ fontSize: 16, color: g.color }}>{g.node}</span>}
                  title={<Text style={{ fontSize: 13 }}>{label(n)}</Text>}
                  description={
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {vnTime(n.createdAt)}
                    </Text>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}
    </div>
  );

  return (
    <Dropdown open={open} onOpenChange={setOpen} trigger={['click']} popupRender={() => panel}>
      <Button type="text" aria-label={t('notif.title')}>
        <Badge count={unread} size="small" overflowCount={99}>
          <BellOutlined style={{ fontSize: 18 }} />
        </Badge>
      </Button>
    </Dropdown>
  );
}
