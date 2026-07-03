import { Tag } from 'antd';
import {
  InboxOutlined,
  UserOutlined,
  SyncOutlined,
  PauseCircleOutlined,
  CheckCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { TICKET_STATUS_COLOR, type TicketStatus } from '@hris/shared';

/** A small icon per status so the badge reads at a glance, not by colour alone. */
const STATUS_ICON: Record<string, React.ReactNode> = {
  open: <InboxOutlined />,
  assigned: <UserOutlined />,
  in_progress: <SyncOutlined />,
  pending: <PauseCircleOutlined />,
  resolved: <CheckCircleOutlined />,
  closed: <StopOutlined />,
};

/** Ticket status badge — colour from the shared palette, label from i18n (party-mode S9). */
export function StatusTag({ status }: { status: string }) {
  const { t } = useTranslation();
  const color = TICKET_STATUS_COLOR[status as TicketStatus] ?? 'default';
  return (
    <Tag color={color} icon={STATUS_ICON[status]}>
      {t(`status.${status}`)}
    </Tag>
  );
}
