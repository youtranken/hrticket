import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Table, Tag, Typography, Empty, Space } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMe } from '../../lib/auth';
import { useTickets, displayCode, type TicketListItem } from '../../lib/tickets';
import { StatusTag } from '../../components/StatusTag';
import i18n from '../../i18n';

const { Title } = Typography;

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

export function InboxPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const { data, isLoading } = useTickets(page, pageSize);
  const ssa = me?.role === 'ssa';
  const lang = i18n.language === 'en' ? 'en' : 'vi';

  const columns: ColumnsType<TicketListItem> = [
    {
      title: t('ticket.code'),
      dataIndex: 'ticketCode',
      width: 130,
      render: (_, r) => <strong>{displayCode(r.ticketCode, r.projectKey, ssa)}</strong>,
    },
    { title: t('ticket.subject'), dataIndex: 'subject', ellipsis: true },
    { title: t('ticket.requester'), dataIndex: 'requesterEmail', width: 200, ellipsis: true },
    {
      title: t('ticket.category'),
      dataIndex: 'category',
      width: 130,
      render: (_, r) => (r.category ? r.category[lang] : '—'),
    },
    {
      title: t('ticket.status'),
      dataIndex: 'status',
      width: 130,
      render: (s: string) => <StatusTag status={s} />,
    },
    {
      title: t('ticket.tags'),
      dataIndex: 'tags',
      width: 160,
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
    { title: t('ticket.time'), dataIndex: 'createdAt', width: 170, render: (v: string) => vnTime(v) },
  ];

  return (
    <div>
      <Title level={4}>{t('menu.inbox')}</Title>
      <Table<TicketListItem>
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        locale={{ emptyText: <Empty description={t('ticket.empty')} /> }}
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
