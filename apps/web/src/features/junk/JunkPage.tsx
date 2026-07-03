import { useTranslation } from 'react-i18next';
import { Card, Table, Button, Empty, Tag, Space, Tooltip, Typography, App as AntApp } from 'antd';
import { TicketsTabBar } from '../inbox/TicketsTabBar';
import { useJunkTickets, useReleaseJunk, type JunkTicket } from '../../lib/junk';
import { useAddBlock } from '../../lib/blocklist';
import { useMe } from '../../lib/auth';

const { Text } = Typography;

/**
 * Junk tab (Story 7.3, FR103). Lists is_junk tickets the caller can see (RLS-scoped
 * server-side). "Không phải rác" releases a ticket; admins can also block the sender.
 */
export function JunkPage() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: me } = useMe();
  const { data: rows = [], isLoading } = useJunkTickets();
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
      <Card title={t('junk.title')}>
        <Text type="secondary">{t('junk.hint')}</Text>
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
          { title: t('junk.colCode'), dataIndex: 'ticketCode', width: 90 },
          { title: t('junk.colSubject'), dataIndex: 'subject', width: 280, ellipsis: true },
          { title: t('junk.colCategory'), dataIndex: 'categoryLabel', width: 120 },
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
            render: (d: string) =>
              new Date(d).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }),
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
      </Card>
    </>
  );
}
