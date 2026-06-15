import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Table, Tag, Typography, Empty, Space, Segmented } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMe } from '../../lib/auth';
import { useTickets, displayCode, type TicketListItem, type SortDir } from '../../lib/tickets';
import { StatusTag } from '../../components/StatusTag';
import { AwayBadge } from '../../components/AwayBadge';
import i18n from '../../i18n';

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

/** Today in VN ('YYYY-MM-DD') — to highlight rows whose snooze comes due today. */
function vnToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

/**
 * Pending tab (Story 10.1, FR80): only snoozed tickets, ordered by snooze date —
 * nearest due first by default, toggleable to oldest. A ticket due TODAY gets a
 * bold-yellow row; one woken by a reply leaves the tab on the next refetch.
 */
export function PendingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [dir, setDir] = useState<SortDir>('asc'); // asc = nearest due first
  const { data, isLoading } = useTickets(page, pageSize, { view: 'pending', sort: 'snooze', dir });
  const ssa = me?.role === 'ssa';
  const lang = i18n.language === 'en' ? 'en' : 'vi';
  const today = vnToday();

  const columns: ColumnsType<TicketListItem> = [
    {
      title: t('ticket.code'),
      dataIndex: 'ticketCode',
      width: 120,
      render: (_, r) => <strong>{displayCode(r.ticketCode, r.projectKey, ssa)}</strong>,
    },
    { title: t('ticket.subject'), dataIndex: 'subject', width: 280, ellipsis: true },
    {
      title: t('ticket.category'),
      dataIndex: 'category',
      width: 130,
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
      title: t('reports.pending.snoozeUntil'),
      dataIndex: 'snoozeUntil',
      width: 160,
      render: (v: string | null, r) =>
        v ? (
          <Space size={6}>
            <span>{v}</span>
            {r.snoozeDue && <Tag color="gold">{t('lifecycle.snoozeDue')}</Tag>}
          </Space>
        ) : (
          '—'
        ),
    },
    { title: t('ticket.time'), dataIndex: 'createdAt', width: 160, render: (v: string) => vnTime(v) },
  ];

  return (
    <div>
      <Space align="center" style={{ marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t('menu.pending')}
        </Typography.Title>
        <Segmented
          value={dir}
          onChange={(v) => {
            setDir(v as SortDir);
            setPage(1);
          }}
          options={[
            { label: t('reports.pending.sortNearest'), value: 'asc' },
            { label: t('reports.pending.sortOldest'), value: 'desc' },
          ]}
        />
      </Space>
      <Table<TicketListItem>
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={t('reports.pending.empty')} /> }}
        onRow={(r) => ({
          onClick: () => navigate(`/tickets/${r.id}`),
          // Due-today rows go bold-yellow so they jump out (FR80).
          style: {
            cursor: 'pointer',
            background: r.snoozeUntil && r.snoozeUntil <= today ? '#fffbe6' : undefined,
            fontWeight: r.snoozeUntil && r.snoozeUntil <= today ? 600 : undefined,
          },
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
