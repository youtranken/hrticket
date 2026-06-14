import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Table, Tag, Typography, Empty, Space, Button, App as AntApp } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMe } from '../../lib/auth';
import { useTickets, useClaim, displayCode, type TicketListItem, type TicketView } from '../../lib/tickets';
import { StatusTag } from '../../components/StatusTag';
import { AwayBadge } from '../../components/AwayBadge';
import i18n from '../../i18n';

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

/** Inbox / "Pool nhóm" / "Ticket của tôi" share one table; `view` swaps the filter
 *  and, in the pool, surfaces a per-row "Nhận" (claim) button (Story 4.4). */
export function TicketListView({ view, titleKey }: { view: TicketView; titleKey: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { data: me } = useMe();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const { data, isLoading } = useTickets(page, pageSize, view);
  const ssa = me?.role === 'ssa';
  const lang = i18n.language === 'en' ? 'en' : 'vi';

  const columns: ColumnsType<TicketListItem> = [
    {
      title: t('ticket.code'),
      dataIndex: 'ticketCode',
      width: 120,
      render: (_, r) => <strong>{displayCode(r.ticketCode, r.projectKey, ssa)}</strong>,
    },
    { title: t('ticket.subject'), dataIndex: 'subject', width: 260, ellipsis: true },
    { title: t('ticket.requester'), dataIndex: 'requesterEmail', width: 180, ellipsis: true },
    {
      title: t('ticket.category'),
      dataIndex: 'category',
      width: 120,
      render: (_, r) => (r.category ? r.category[lang] : '—'),
    },
    {
      title: t('ticket.assignee'),
      dataIndex: 'assignee',
      width: 170,
      render: (_, r) =>
        r.assignee ? (
          <span>
            {r.assignee.name}
            <AwayBadge awayFrom={r.assignee.awayFrom} awayTo={r.assignee.awayTo} />
          </span>
        ) : (
          <Tag>{t('ticket.pool')}</Tag>
        ),
    },
    {
      title: t('ticket.status'),
      dataIndex: 'status',
      width: 120,
      render: (s: string) => <StatusTag status={s} />,
    },
    {
      title: t('ticket.tags'),
      dataIndex: 'tags',
      width: 150,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.tags.map((tg) => (
            <Tag key={tg.name} color={tg.color ?? 'default'}>
              {tg.name}
            </Tag>
          ))}
        </Space>
      ),
    },
    { title: t('ticket.time'), dataIndex: 'createdAt', width: 160, render: (v: string) => vnTime(v) },
  ];

  if (view === 'pool') {
    columns.push({
      title: '',
      width: 90,
      render: (_, r) => <ClaimButton ticketId={r.id} onDone={() => message.success(t('ticket.claimed'))} onLose={() => message.warning(t('ticket.claimLost'))} />,
    });
  }

  return (
    <div>
      <Typography.Title level={4}>{t(titleKey)}</Typography.Title>
      <Table<TicketListItem>
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={t('ticket.empty')} /> }}
        onRow={(r) => ({
          onClick: (e) => {
            // Don't navigate when the click came from the row's claim button.
            if ((e.target as HTMLElement).closest('button')) return;
            navigate(`/tickets/${r.id}`);
          },
          style: { cursor: 'pointer' },
        })}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
    </div>
  );
}

/** Self-contained claim button so each row gets its own mutation + race handling. */
function ClaimButton({ ticketId, onDone, onLose }: { ticketId: string; onDone: () => void; onLose: () => void }) {
  const { t } = useTranslation();
  const claim = useClaim(ticketId);
  return (
    <Button
      size="small"
      type="primary"
      loading={claim.isPending}
      onClick={() =>
        claim.mutate({}, { onSuccess: onDone, onError: onLose })
      }
    >
      {t('ticket.claim')}
    </Button>
  );
}
