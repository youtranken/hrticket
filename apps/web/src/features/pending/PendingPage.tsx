import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Table, Tag, Empty, Space, Button, Dropdown } from 'antd';
import { SortAscendingOutlined, DownOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { SorterResult } from 'antd/es/table/interface';
import { useMe } from '../../lib/auth';
import { TicketsTabBar } from '../inbox/TicketsTabBar';
import {
  useTickets,
  displayCode,
  type TicketListItem,
  type TicketSort,
  type SortDir,
} from '../../lib/tickets';
import { StatusTag } from '../../components/StatusTag';
import { AwayBadge } from '../../components/AwayBadge';
import { TableSkeleton } from '../../components/TableSkeleton';
import i18n from '../../i18n';
import { fmtDateTime } from '../../lib/datetime';
import { palette } from '../../theme';
import { CategoryTag } from '../../components/CategoryTag';

function vnTime(iso: string): string {
  return fmtDateTime(iso);
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
  // #20: the snooze dropdown AND the column headers drive the same server sort.
  const [sort, setSort] = useState<TicketSort>('snooze');
  const [dir, setDir] = useState<SortDir>('asc'); // asc = nearest due first
  const { data, isLoading, isError, refetch } = useTickets(page, pageSize, {
    view: 'pending',
    sort,
    dir,
  });
  const sortOrderFor = (col: TicketSort) =>
    sort === col ? (dir === 'asc' ? ('ascend' as const) : ('descend' as const)) : null;
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
      render: (_, r) => <CategoryTag category={r.category} lang={lang} />,
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
      key: 'status',
      width: 120,
      render: (s: string) => <StatusTag status={s} />,
      sorter: true,
      sortOrder: sortOrderFor('status'),
    },
    {
      title: t('reports.pending.snoozeUntil'),
      dataIndex: 'snoozeUntil',
      key: 'snooze',
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
      sorter: true,
      sortOrder: sortOrderFor('snooze'),
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
    sorter: SorterResult<TicketListItem> | SorterResult<TicketListItem>[],
  ) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    if (!s?.order) {
      setSort('snooze');
      setDir('asc'); // 3rd click → back to the tab's default (nearest due first)
    } else {
      setSort((s.columnKey ?? 'snooze') as TicketSort);
      setDir(s.order === 'ascend' ? 'asc' : 'desc');
    }
    setPage(1);
  };

  return (
    <div>
      {/* Tab bar (with "Chờ xử lý" active) on the left; the snooze-sort control on the
          right — no separate page title, which only duplicated the active tab. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          marginBottom: 12,
        }}
      >
        <TicketsTabBar mb={0} />
        <Space>
        <Button
          icon={<ReloadOutlined />}
          aria-label={t('common.retry')}
          loading={isLoading}
          onClick={() => refetch()}
        />
        <Dropdown
          trigger={['click']}
          menu={{
            selectable: true,
            selectedKeys: [dir],
            items: [
              { key: 'asc', label: t('reports.pending.sortNearest') },
              { key: 'desc', label: t('reports.pending.sortOldest') },
            ],
            onClick: ({ key }) => {
              setSort('snooze');
              setDir(key as SortDir);
              setPage(1);
            },
          }}
        >
          <Button icon={<SortAscendingOutlined />}>
            {dir === 'asc' ? t('reports.pending.sortNearest') : t('reports.pending.sortOldest')}
            <DownOutlined style={{ fontSize: 10, marginInlineStart: 2 }} />
          </Button>
        </Dropdown>
        </Space>
      </div>
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
      <Table<TicketListItem>
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={t('reports.pending.empty')} /> }}
        onChange={onTableChange}
        onRow={(r) => ({
          onClick: () => navigate(`/tickets/${r.id}`),
          // Due-today rows go bold-yellow so they jump out (FR80).
          style: {
            cursor: 'pointer',
            background: r.snoozeUntil && r.snoozeUntil <= today ? palette.noteSoft : undefined,
            fontWeight: r.snoozeUntil && r.snoozeUntil <= today ? 600 : undefined,
          },
        })}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          hideOnSinglePage: true,
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
