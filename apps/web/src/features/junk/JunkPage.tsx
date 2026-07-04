import { useTranslation } from 'react-i18next';
import { Alert, Card, Table, Button, Empty, Tag, Space, Tooltip, Typography, App as AntApp } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { TicketsTabBar } from '../inbox/TicketsTabBar';
import { useJunkTickets, useReleaseJunk, type JunkTicket } from '../../lib/junk';
import { useAddBlock } from '../../lib/blocklist';
import { useMe } from '../../lib/auth';
import { fmtDateTime } from '../../lib/datetime';
import { TableSkeleton } from '../../components/TableSkeleton';

const { Text } = Typography;

/**
 * Junk tab (Story 7.3, FR103). Lists is_junk tickets the caller can see (RLS-scoped
 * server-side). "Không phải rác" releases a ticket; admins can also block the sender.
 */
export function JunkPage() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: me } = useMe();
  const { data: rows = [], isLoading, isError, refetch } = useJunkTickets();
  const release = useReleaseJunk();
  const addBlock = useAddBlock();
  const isAdmin = me?.role === 'admin' || me?.role === 'ssa';

  const onRelease = (row: JunkTicket) => {
    release.mutate(row.id, {
      onSuccess: (res) =>
        message.success(res.reAcked ? t('junk.releasedAcked') : t('junk.released')),
      onError: (e) => message.error(e.message),
    });
  };

  const onBlock = (row: JunkTicket) => {
    modal.confirm({
      title: t('junk.confirmBlock', { email: row.requesterEmail }),
      okButtonProps: { danger: true },
      onOk: () =>
        addBlock
          .mutateAsync({ email: row.requesterEmail, reason: t('junk.blockReason') })
          .then(() => message.success(t('spam.blocklist.added')))
          .catch((e: Error) => message.error(e.message)),
    });
  };

  return (
    <>
      <TicketsTabBar />
      <Card
        title={t('junk.title')}
        extra={
          <Button
            icon={<ReloadOutlined />}
            aria-label={t('common.retry')}
            loading={isLoading}
            onClick={() => refetch()}
          />
        }
      >
        <Text type="secondary">{t('junk.hint')}</Text>
      {isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 12 }}
          message={t('ticket.loadError')}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {isLoading && rows.length === 0 ? (
        <div style={{ marginTop: 12 }}>
          <TableSkeleton />
        </div>
      ) : (
      <Table<JunkTicket>
        rowKey="id"
        style={{ marginTop: 12 }}
        loading={isLoading}
        dataSource={rows}
        scroll={{ x: 900 }}
        locale={{ emptyText: <Empty description={t('junk.empty')} /> }}
        pagination={{
          pageSize: 20,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100],
          showTotal: (total) => t('common.totalRows', { total }),
        }}
        columns={[
          {
            title: t('junk.colCode'),
            dataIndex: 'ticketCode',
            width: 90,
            sorter: (a: JunkTicket, b: JunkTicket) => a.ticketCode.localeCompare(b.ticketCode),
          },
          {
            title: t('junk.colSubject'),
            dataIndex: 'subject',
            width: 280,
            ellipsis: true,
            sorter: (a: JunkTicket, b: JunkTicket) => a.subject.localeCompare(b.subject),
          },
          {
            title: t('junk.colCategory'),
            dataIndex: 'categoryLabel',
            width: 120,
            sorter: (a: JunkTicket, b: JunkTicket) =>
              (a.categoryLabel ?? '').localeCompare(b.categoryLabel ?? ''),
          },
          {
            title: t('junk.colCaughtBy'),
            width: 160,
            render: (_: unknown, r: JunkTicket) =>
              r.isAuto ? (
                <Tooltip title={r.caughtBy ?? ''}>
                  <Tag color="volcano">{r.caughtBy ? t('junk.rule', { p: r.caughtBy }) : t('junk.auto')}</Tag>
                </Tooltip>
              ) : (
                <Tag>{t('junk.manual')}</Tag>
              ),
          },
          {
            title: t('junk.colReceived'),
            dataIndex: 'createdAt',
            width: 170,
            render: (d: string) => fmtDateTime(d),
            // Client sort is exact here — the junk list arrives unpaged (ISO strings).
            sorter: (a: JunkTicket, b: JunkTicket) => a.createdAt.localeCompare(b.createdAt),
            defaultSortOrder: 'descend',
          },
          {
            title: '',
            width: 220,
            render: (_: unknown, r: JunkTicket) => (
              <Space>
                <Button size="small" type="primary" onClick={() => onRelease(r)}>
                  {t('junk.notSpam')}
                </Button>
                {isAdmin && (
                  <Button size="small" danger onClick={() => onBlock(r)}>
                    {t('junk.blockSender')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      )}
      </Card>
    </>
  );
}
