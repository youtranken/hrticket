import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Table, Tag, Typography, Empty, Space, Button, App as AntApp } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import type { SorterResult } from 'antd/es/table/interface';
import { useMe } from '../../lib/auth';
import {
  useTickets,
  useClaim,
  displayCode,
  type TicketListItem,
  type TicketView,
  type TicketFilters,
  type TicketSort,
} from '../../lib/tickets';
import { StatusTag } from '../../components/StatusTag';
import { AwayBadge } from '../../components/AwayBadge';
import { TicketFilterBar } from './TicketFilterBar';
import { filtersFromParams, paramsFromFilters } from './filterUrl';
import { ExportButton } from '../reports/ExportButton';
import { exportTickets } from '../../lib/export';
import i18n from '../../i18n';

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

/** Inbox / "Pool nhóm" / "Ticket của tôi" share one table; `view` swaps the filter
 *  and, in the pool, surfaces a per-row "Nhận" (claim) button (Story 4.4). The
 *  Inbox additionally shows the filter bar with URL-synced, shareable state (10.1). */
export function TicketListView({
  view,
  titleKey,
  filterable = false,
}: {
  view: TicketView;
  titleKey: string;
  filterable?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { data: me } = useMe();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // The fixed tabs (mine/pool) pin their view; the Inbox reads it from the URL.
  const urlFilters = filterable ? filtersFromParams(searchParams) : {};
  const filters: TicketFilters = filterable ? { view: 'all', ...urlFilters } : { view };
  const { data, isLoading } = useTickets(page, pageSize, filters);
  const ssa = me?.role === 'ssa';
  const lang = i18n.language === 'en' ? 'en' : 'vi';

  const applyFilters = (next: TicketFilters) => {
    setPage(1);
    setSearchParams(paramsFromFilters(next), { replace: false });
  };
  const isWorklistOrder = !filters.sort || filters.sort === 'worklist';

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
      width: 140,
      sorter: filterable ? true : undefined,
      sortOrder: filterable && filters.sort === 'status' ? (filters.dir === 'asc' ? 'ascend' : 'descend') : undefined,
      render: (s: string, r) => (
        <Space direction="vertical" size={2}>
          <StatusTag status={s} />
          {r.isOverdue && <Tag color="error">{t('lifecycle.overdueDays', { count: r.overdueDays })}</Tag>}
          {r.snoozeDue && <Tag color="gold">{t('lifecycle.snoozeDue')}</Tag>}
        </Space>
      ),
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
    {
      title: t('ticket.time'),
      dataIndex: 'createdAt',
      width: 160,
      sorter: filterable ? true : undefined,
      sortOrder:
        filterable && filters.sort === 'created' ? (filters.dir === 'asc' ? 'ascend' : 'descend') : undefined,
      render: (v: string) => vnTime(v),
    },
  ];

  /** Manual column sort → drive the URL `sort`/`dir`; clearing returns to the
   *  shared worklist order (the "Về thứ tự chuẩn" path, FR106). */
  const handleTableChange = (
    _pg: TablePaginationConfig,
    _filters: Record<string, unknown>,
    sorter: SorterResult<TicketListItem> | SorterResult<TicketListItem>[],
  ) => {
    if (!filterable) return;
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const col = s?.field === 'createdAt' ? 'created' : s?.field === 'status' ? 'status' : undefined;
    if (!col || !s?.order) {
      applyFilters({ ...filters, sort: undefined, dir: undefined });
    } else {
      applyFilters({ ...filters, sort: col as TicketSort, dir: s.order === 'ascend' ? 'asc' : 'desc' });
    }
  };

  if (view === 'pool') {
    columns.push({
      title: '',
      width: 90,
      render: (_, r) => <ClaimButton ticketId={r.id} onDone={() => message.success(t('ticket.claimed'))} onLose={() => message.warning(t('ticket.claimLost'))} />,
    });
  }

  return (
    <div>
      <Space align="center" style={{ marginBottom: 8, width: '100%' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t(titleKey)}
        </Typography.Title>
        {(data?.overdueTotal ?? 0) > 0 && (
          <Tag color="error">{t('lifecycle.overdueCount', { count: data!.overdueTotal })}</Tag>
        )}
        {filterable && (
          <span style={{ marginLeft: 'auto' }}>
            <ExportButton onExport={(format) => exportTickets(filters, format)} />
          </span>
        )}
      </Space>
      {filterable && (
        <TicketFilterBar
          value={filters}
          onChange={applyFilters}
          onReset={() => applyFilters({ view: 'all' })}
          isWorklistOrder={isWorklistOrder}
        />
      )}
      <Table<TicketListItem>
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        scroll={{ x: 'max-content' }}
        onChange={handleTableChange}
        locale={{ emptyText: <Empty description={t('ticket.empty')} /> }}
        onRow={(r) => ({
          onClick: (e) => {
            // Don't navigate when the click came from the row's claim button.
            if ((e.target as HTMLElement).closest('button')) return;
            navigate(`/tickets/${r.id}`);
          },
          // Overdue rows get a soft-red background so the worklist screams at a glance (5.6).
          style: { cursor: 'pointer', background: r.isOverdue ? '#fff1f0' : undefined },
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
