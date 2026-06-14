import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Dropdown, Empty, List, Typography } from 'antd';
import {
  useNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  type NotificationItem,
} from '../../lib/notifications';

const { Text } = Typography;

/** Icon glyph per notification type — keeps the dropdown scannable at a glance. */
function glyph(type: string): string {
  if (type.startsWith('ticket_assigned')) return '📥';
  if (type.startsWith('ticket_reassigned') || type === 'ticket_resumed') return '🔁';
  if (type === 'ticket_reopened' || type === 'ticket_reopened_pool') return '↩️';
  if (type === 'snooze_due') return '⏰';
  if (type.endsWith('_failed')) return '⚠️';
  return '🔔';
}

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
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

  const label = (n: NotificationItem): string => {
    const code = n.payload?.ticketCode ?? '';
    const by = n.payload?.by ? ` · ${n.payload.by}` : '';
    return `${t(`notif.${n.type}`, { defaultValue: t('notif.generic') })} ${code}${by}`.trim();
  };

  const panel = (
    <div style={{ width: 340, background: '#fff', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.15)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px' }}>
        <Text strong>{t('notif.title')}</Text>
        {unread > 0 && (
          <a onClick={() => markAll.mutate()}>{t('notif.markAll')}</a>
        )}
      </div>
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notif.empty')} style={{ padding: 16 }} />
      ) : (
        <List
          size="small"
          dataSource={items}
          style={{ maxHeight: 400, overflowY: 'auto' }}
          renderItem={(n) => (
            <List.Item
              onClick={() => onClickItem(n)}
              style={{ cursor: 'pointer', padding: '8px 12px', background: n.readAt ? undefined : '#e6f4ff' }}
            >
              <List.Item.Meta
                avatar={<span style={{ fontSize: 18 }}>{glyph(n.type)}</span>}
                title={<Text style={{ fontSize: 13 }}>{label(n)}</Text>}
                description={<Text type="secondary" style={{ fontSize: 11 }}>{vnTime(n.createdAt)}</Text>}
              />
            </List.Item>
          )}
        />
      )}
    </div>
  );

  return (
    <Dropdown open={open} onOpenChange={setOpen} trigger={['click']} popupRender={() => panel}>
      <Button type="text" aria-label={t('notif.title')}>
        <Badge count={unread} size="small" overflowCount={99}>
          <span style={{ fontSize: 18 }}>🔔</span>
        </Badge>
      </Button>
    </Dropdown>
  );
}
