import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Table, Tag, Typography, Empty, Space } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMe } from '../../lib/auth';
import { useTicketSearch, displayCode, type SearchResultItem } from '../../lib/tickets';
import { StatusTag } from '../../components/StatusTag';
import { renderHeadline } from './headline';
import i18n from '../../i18n';

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
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
  const { data, isLoading } = useTicketSearch(q, page, pageSize);
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
      render: (_, r) => (r.category ? r.category[lang] : '—'),
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
    },
    { title: t('ticket.time'), dataIndex: 'createdAt', width: 160, render: (v: string) => vnTime(v) },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 12 }}>
        {t('reports.search.resultsFor', { q })}
      </Typography.Title>
      <Table<SearchResultItem>
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={t('reports.search.empty')} /> }}
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
    </div>
  );
}
