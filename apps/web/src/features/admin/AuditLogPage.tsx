import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams, Link } from 'react-router-dom';
import { Card, Table, Tabs, Tag, Input, Select, Space, Typography, Button, Tooltip } from 'antd';
import { useAudit, useAuditActions, useViewLog, type AuditRow, type ViewLogRow } from '../../lib/audit';
import { fmtDateTime } from '../../lib/datetime';
import { exportAudit } from '../../lib/export';
import { ExportButton } from '../reports/ExportButton';
import { TableSkeleton } from '../../components/TableSkeleton';

const { Text } = Typography;

function fmt(iso: string): string {
  return fmtDateTime(iso);
}

/** Readable object cell: a ticket shows its #code (linked) + subject + short uid; a user
 *  shows name (email); everything else keeps the raw type:id. */
function ObjectCell({ row }: { row: AuditRow }) {
  if (row.objectType === 'ticket' && row.objectId) {
    const shortId = row.objectId.slice(0, 8);
    return (
      <Space direction="vertical" size={0}>
        <span>
          <Link to={`/tickets/${row.objectId}`} onClick={(e) => e.stopPropagation()}>
            <Text strong>{row.ticketCode ?? '#?'}</Text>
          </Link>
          {row.objectLabel && (
            <Text style={{ marginLeft: 6 }}>· {row.objectLabel.replace(`${row.ticketCode} · `, '')}</Text>
          )}
        </span>
        <Tooltip title={row.objectId}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {shortId}…
          </Text>
        </Tooltip>
      </Space>
    );
  }
  if (row.objectType === 'user') {
    return <span>{row.objectLabel ?? `user:${row.objectId ?? ''}`}</span>;
  }
  if (!row.objectType) return <>—</>;
  return (
    <span>
      {row.objectType}
      {row.objectId ? `:${row.objectId}` : ''}
    </span>
  );
}

/** Story 9.5 — Audit log + sensitive view-log reader (Admin/TL/SSA; Member → 403). */
export function AuditLogPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const ticketId = params.get('ticketId') ?? undefined;

  return (
    <Card title={t('audit.title')}>
      {ticketId && (
        <Space style={{ marginBottom: 12 }}>
          <Tag color="blue">{t('audit.filteredByTicket')}</Tag>
          <Button
            size="small"
            onClick={() => {
              params.delete('ticketId');
              setParams(params);
            }}
          >
            {t('audit.clearTicket')}
          </Button>
        </Space>
      )}
      <Tabs
        items={[
          { key: 'log', label: t('audit.tabLog'), children: <AuditTab ticketId={ticketId} /> },
          { key: 'view', label: t('audit.tabViewLog'), children: <ViewLogTab ticketId={ticketId} /> },
        ]}
      />
    </Card>
  );
}

function AuditTab({ ticketId }: { ticketId?: string }) {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [action, setAction] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const { data: actionOpts } = useAuditActions();
  const filter = {
    ticketId,
    from: from ? `${from}T00:00:00Z` : undefined,
    to: to ? `${to}T23:59:59Z` : undefined,
    action: action || undefined,
  };
  const { data, isFetching } = useAudit({ ...filter, page, pageSize: 50 });

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <span>
          {t('audit.from')}: <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
        </span>
        <span>
          {t('audit.to')}: <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
        </span>
        {/* #55: pick from the actions that actually exist — no more guessing raw codes. */}
        <Select
          placeholder={t('audit.actionFilter')}
          value={action}
          onChange={(v) => {
            setAction(v);
            setPage(1);
          }}
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 260 }}
          options={(actionOpts?.actions ?? []).map((a) => ({
            value: a,
            label: `${t(`auditAction.${a}`, a)} (${a})`,
          }))}
        />
        <ExportButton onExport={(format) => exportAudit(filter, format)} />
      </Space>
      {isFetching && !data ? (
        <TableSkeleton />
      ) : (
      <Table<AuditRow>
        rowKey="id"
        loading={isFetching}
        dataSource={data?.items ?? []}
        // Fixed widths + x-scroll: flex columns can collapse to 0 (CLAUDE.md pitfall).
        scroll={{ x: 'max-content' }}
        pagination={{
          current: page,
          pageSize: 50,
          total: data?.total ?? 0,
          onChange: setPage,
          hideOnSinglePage: true,
        }}
        expandable={{
          rowExpandable: (r) => r.oldValue != null || r.newValue != null,
          expandedRowRender: (r) => (
            <Space size="large" align="start">
              <div>
                <Text type="secondary">{t('audit.old')}</Text>
                <pre style={{ margin: 0 }}>{JSON.stringify(r.oldValue, null, 2)}</pre>
              </div>
              <div>
                <Text type="secondary">{t('audit.new')}</Text>
                <pre style={{ margin: 0 }}>{JSON.stringify(r.newValue, null, 2)}</pre>
              </div>
            </Space>
          ),
        }}
        columns={[
          { title: t('audit.time'), width: 170, render: (_: unknown, r: AuditRow) => fmt(r.createdAt) },
          { title: t('audit.actor'), width: 200, render: (_: unknown, r: AuditRow) => r.actorLabel ?? '—' },
          {
            title: t('audit.action'),
            width: 220,
            render: (_: unknown, r: AuditRow) => <Tag>{t(`auditAction.${r.action}`, r.action)}</Tag>,
          },
          {
            title: t('audit.object'),
            width: 320,
            render: (_: unknown, r: AuditRow) => <ObjectCell row={r} />,
          },
        ]}
      />
      )}
    </>
  );
}

function ViewLogTab({ ticketId }: { ticketId?: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const { data, isFetching } = useViewLog({ ticketId, page, pageSize: 50 });

  return (
    <Table<ViewLogRow>
      rowKey="id"
      loading={isFetching}
      dataSource={data?.items ?? []}
      pagination={{ current: page, pageSize: 50, total: data?.total ?? 0, onChange: setPage, hideOnSinglePage: true }}
      columns={[
        { title: t('audit.time'), width: 170, render: (_: unknown, r: ViewLogRow) => fmt(r.createdAt) },
        { title: t('audit.who'), render: (_: unknown, r: ViewLogRow) => `${r.actorName} (${r.actorEmail})` },
        {
          title: t('audit.action'),
          width: 150,
          render: (_: unknown, r: ViewLogRow) =>
            r.action === 'file_download' ? (
              <Tag color="orange">{t('audit.download')}</Tag>
            ) : (
              <Tag>{t('audit.view')}</Tag>
            ),
        },
        { title: t('ticket.code'), width: 120, render: (_: unknown, r: ViewLogRow) => r.ticketCode },
        { title: t('audit.file'), render: (_: unknown, r: ViewLogRow) => r.fileName ?? '—' },
      ]}
    />
  );
}
