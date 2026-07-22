import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { App, Badge, Button, Dropdown, Empty, List, Typography } from 'antd';
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
  if (type === 'ticket_reopened' || type === 'ticket_reopened_pool') return { node: <RollbackOutlined />, color: palette.warning };
  if (type === 'snooze_due') return { node: <ClockCircleOutlined />, color: palette.warning };
  if (type === 'disk_low') return { node: <HddOutlined />, color: palette.error };
  if (type === 'mail_bomb' || type === 'mailbox_down') return { node: <WarningOutlined />, color: palette.error };
  if (type === 'worker_alert' || type === 'worker_down' || type.endsWith('_failed'))
    return { node: <ExclamationCircleOutlined />, color: palette.error };
  return { node: <BellOutlined />, color: '#8c8c8c' };
}

function vnTime(iso: string): string {
  return fmtDateTime(iso);
}

/** Notifications that describe a system/health problem, not a ticket — clicking one opens
 *  a detail popup (error + what-to-do) instead of navigating to a ticket. */
const ALERT_TYPES = new Set([
  'worker_alert',
  'worker_down',
  'mailbox_down',
  'disk_low',
  'mail_bomb',
  'inbox_failed',
  'outbox_failed',
]);

/** Header notification bell with unread badge + dropdown list (Story 6.1). */
export function NotificationBell() {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const navigate = useNavigate();
  const { data } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const [open, setOpen] = useState(false);

  const items = data?.items ?? [];
  const unread = data?.unreadCount ?? 0;

  // Pass the whole payload into i18n so type-specific keys can interpolate (e.g. the
  // mail-bomb sender); append a ticket code / actor when present.
  const label = (n: NotificationItem): string => {
    // Worker-liveness alert: append WHICH loop(s) are down, translated to the user's
    // language, so "Cảnh báo hệ thống" is no longer a detail-free dead end.
    if (n.type === 'worker_alert' && Array.isArray(n.payload?.loops) && n.payload.loops.length) {
      const loops = n.payload.loops.map((l) => t(`notif.loop.${l}`, { defaultValue: l })).join(', ');
      return `${t('notif.worker_alert')}: ${loops}`;
    }
    const base = t(`notif.${n.type}`, { defaultValue: t('notif.generic'), ...(n.payload ?? {}) });
    const code = n.payload?.ticketCode ? ` ${n.payload.ticketCode}` : '';
    const by = n.payload?.by ? ` · ${n.payload.by}` : '';
    return `${base}${code}${by}`.trim();
  };

  // Alert-type notifications have no ticket to open — clicking one shows a popup with the
  // specific error plus a hint on what to do; for a broken mailbox it offers a shortcut to
  // the email-connection page where the App Password is re-entered.
  const showAlertDetail = (n: NotificationItem): void => {
    const help = t(`notif.help.${n.type}`, { defaultValue: '', ...(n.payload ?? {}) });
    const content = (
      <div>
        <div>{label(n)}</div>
        {help && (
          <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            {help}
          </Text>
        )}
      </div>
    );
    if (n.type === 'mailbox_down') {
      modal.confirm({
        title: t('notif.detailTitle'),
        icon: <ExclamationCircleOutlined style={{ color: palette.error }} />,
        content,
        okText: t('notif.gotoEmailConfig'),
        cancelText: t('notif.close'),
        onOk: () => navigate('/admin/email-connection'),
      });
    } else {
      modal.info({ title: t('notif.detailTitle'), content, okText: t('notif.close') });
    }
  };

  const onClickItem = (n: NotificationItem): void => {
    if (!n.readAt) markRead.mutate(n.id);
    setOpen(false);
    if (n.payload?.ticketId) {
      navigate(`/tickets/${n.payload.ticketId}`);
      return;
    }
    if (ALERT_TYPES.has(n.type)) showAlertDetail(n);
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
