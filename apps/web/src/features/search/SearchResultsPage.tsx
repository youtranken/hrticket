import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Table, Tag, Typography, Empty, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { SorterResult } from 'antd/es/table/interface';
import { useMe } from '../../lib/auth';
import {
  useTicketSearch,
  displayCode,
  type SearchResultItem,
  type SearchSort,
  type SortDir,
} from '../../lib/tickets';
import { StatusTag } from '../../components/StatusTag';
import { CategoryTag } from '../../components/CategoryTag';
import { TableSkeleton } from '../../components/TableSkeleton';
import { renderHeadline } from './headline';
import i18n from '../../i18n';
import { fmtDateTime } from '../../lib/datetime';

function vnTime(iso: string): string {
  return fmtDateTime(iso);
}

/** Full search-results page (Story 10.2). `?q=` drives the query; rows open the ticket. */
export function SearchResultsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // #20: header-sortable columns — relevance stays the default order.
  const [order, setOrder] = useState<{ sort: SearchSort; dir: SortDir }>({
    sort: 'relevance',
    dir: 'desc',
  });
  const { data, isLoading, isError, refetch } = useTicketSearch(q, page, pageSize, true, order);
  const sortOrderFor = (col: SearchSort) =>
    order.sort === col ? (order.dir === 'asc' ? ('ascend' as const) : ('descend' as const)) : null;
  const ssa = me?.role === 'ssa';
  const lang = i18n.language === 'en' ? 'en' : 'vi';

  const columns: ColumnsType<SearchResultItem> = [
    {
      title: t('ticket.code'),
      dataIndex: 'ticketCode',
      width: 120,
      render: (_, r) => <strong>{displayCode(r.ticketCode, r.projectKey, ssa)}</strong>,
    },
    {
      title: t('ticket.subject'),
      dataIndex: 'subject',
      width: 320,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.subject}</span>
          {r.headline && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {renderHeadline(r.headline)}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: t('reports.search.matchedOn'),
      dataIndex: 'matchType',
      width: 120,
      render: (m: string) => <Tag>{t(`reports.search.match.${m}`)}</Tag>,
    },
    { title: t('ticket.requester'), dataIndex: 'requesterEmail', width: 180, ellipsis: true },
    {
      title: t('ticket.category'),
      dataIndex: 'category',
      width: 120,
      render: (_, r) => <CategoryTag category={r.category} lang={lang} />,
    },
    {
      title: t('ticket.assignee'),
      dataIndex: 'assignee',
      width: 160,
      render: (_, r) => (r.assignee ? r.assignee.name : <Tag>{t('ticket.pool')}</Tag>),
    },
    {
      title: t('ticket.status'),
      dataIndex: 'status',
      width: 120,
      render: (s: string) => <StatusTag status={s} />,
      sorter: true,
      sortOrder: sortOrderFor('status'),
    },
    {
      title: t('ticket.time'),
      dataIndex: 'createdAt',
      key: 'created',
      width: 160,
      render: (v: string) => vnTime(v),
      sorter: true,
      sortOrder: sortOrderFor('created'),
    },
  ];

  const onTableChange = (
    _p: unknown,
    _f: unknown,
    sorter: SorterResult<SearchResultItem> | SorterResult<SearchResultItem>[],
  ) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    if (!s?.order) {
      setOrder({ sort: 'relevance', dir: 'desc' }); // 3rd click → back to relevance
    } else {
      const col = (s.columnKey ?? s.field) === 'status' ? 'status' : 'created';
      setOrder({ sort: col, dir: s.order === 'ascend' ? 'asc' : 'desc' });
    }
    setPage(1);
  };

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t('reports.search.resultsFor', { q })}
        </Typography.Title>
        <Button
          icon={<ReloadOutlined />}
          aria-label={t('common.retry')}
          loading={isLoading}
          onClick={() => refetch()}
        />
      </Space>
      {isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('ticket.loadError')}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {isLoading && !data ? (
        <TableSkeleton />
      ) : (
      <Table<SearchResultItem>
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={t('reports.search.empty')} /> }}
        onChange={onTableChange}
        onRow={(r) => ({ onClick: () => navigate(`/tickets/${r.id}`), style: { cursor: 'pointer' } })}
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
      )}
    </div>
  );
}
