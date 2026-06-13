import { Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { TICKET_STATUS_COLOR, type TicketStatus } from '@hris/shared';

/** Ticket status badge — colour from the shared palette, label from i18n (party-mode S9). */
export function StatusTag({ status }: { status: string }) {
  const { t } = useTranslation();
  const color = TICKET_STATUS_COLOR[status as TicketStatus] ?? 'default';
  return <Tag color={color}>{t(`status.${status}`)}</Tag>;
}
