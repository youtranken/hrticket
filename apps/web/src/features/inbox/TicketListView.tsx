import { useEffect, useRef, useState, type Key } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Table, Tag, Typography, Space, Button, Tooltip, Modal, Select, Avatar, Popover, Progress, Spin, Badge, Alert, App as AntApp } from 'antd';
import {
  TagsOutlined,
  CheckOutlined,
  UserOutlined,
  ArrowUpOutlined,
  FilterOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  FlagOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import type { SorterResult, TableCurrentDataSource } from 'antd/es/table/interface';
import { hasCap, useMe } from '../../lib/auth';
import { api } from '../../lib/apiClient';
import {
  useTickets,
  useTicketTotal,
  useTicketTags,
  addTicketTag,
  removeTicketTag,
  useClaim,
  useFilterOptions,
  displayCode,
  type TicketListItem,
  type TicketView,
  type TicketFilters,
  type TicketSort,
  type AvailableTag,
  type CategoryOption,
  type ClaimResponse,
} from '../../lib/tickets';
import { StatusTag } from '../../components/StatusTag';
import { AwayBadge } from '../../components/AwayBadge';
import { TableSkeleton } from '../../components/TableSkeleton';
import { TicketFilterPanel, TicketFilterChips, activeCount } from './TicketFilterBar';
import { TicketsTabBar } from './TicketsTabBar';
import { CreateTicketModal } from './CreateTicketModal';
import { filtersFromParams, paramsFromFilters } from './filterUrl';
import { ExportButton } from '../reports/ExportButton';
import { exportTickets } from '../../lib/export';
import i18n from '../../i18n';
import { palette } from '../../theme';
import { CategoryTag } from '../../components/CategoryTag';
import { EmptyState } from '../../components/EmptyState';
import { InboxZeroArt } from '../../components/illustrations/empty';
import { fmtDateTime, fmtRelative } from '../../lib/datetime';

function vnTime(iso: string): string {
  return fmtDateTime(iso);
}

// Deterministic avatar colour from the requester address (stable per person).
const AVATAR_COLORS = [palette.primary, '#2D6A4F', '#7C3AED', '#D97706', '#0E7490', '#B91C1C', '#4338CA', '#A16207'];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? palette.primary;
}
function initialOf(s: string): string {
  return (s.trim()[0] ?? '?').toUpperCase();
}
/** "Mới" = nobody has opened the ticket yet AND it isn't assigned — a genuinely fresh,
 *  untouched pool ticket. The badge drops the moment any staff opens the detail (server
 *  stamps first_read_at) or it gets assigned. */
function isNew(t: TicketListItem): boolean {
  return !t.firstReadAt && !t.assignee;
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
  const qc = useQueryClient();
  const { data: opts } = useFilterOptions();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // Bulk selection + assign (FE loops the single-assign endpoint).
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAssignee, setBulkAssignee] = useState<string>();
  const [bulkBusy, setBulkBusy] = useState(false);
  // #17: tickets that failed the bulk assign (kept selected for a one-click retry).
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false); // right-column filter panel toggle
  const [createOpen, setCreateOpen] = useState(false); // manual "new ticket" modal
  // Manual ticket creation is for the people who process them — project Admin / TL /
  // Member. SSA (cross-project superuser) doesn't open a single project's tickets.
  const canCreate = !!me && me.role !== 'ssa';
  // Row selection exists ONLY to feed bulk assign — hide it from roles that can't
  // assign others (a member's checkboxes were a dead control that always 403'd).
  const canBulkAssign = hasCap(me, 'ticket.assign_others');

  const runBulkAssign = async () => {
    if (!bulkAssignee) return;
    setBulkBusy(true);
    setBulkErrors([]);
    // Selected rows can only come from the CURRENT page, so its items carry the codes.
    const codeOf = new Map((data?.items ?? []).map((r) => [r.id as Key, r.ticketCode]));
    let results: Array<{ ticketId: string; ok: boolean; error?: string }>;
    try {
      // ONE batch request (roadmap #4) — the server loops assign per ticket (own tx
      // each) and returns a per-ticket verdict; "needsCategory" counts as a failure.
      const res = await api<{ results: typeof results }>(`/tickets/bulk-assign`, {
        method: 'POST',
        body: JSON.stringify({ ticketIds: selectedKeys, assigneeId: bulkAssignee }),
      });
      results = res.results;
    } catch (e) {
      setBulkBusy(false);
      message.error((e as Error).message);
      return;
    }
    setBulkBusy(false);
    await qc.invalidateQueries({ queryKey: ['tickets'] });
    await qc.invalidateQueries({ queryKey: ['tickets-poll'] });
    const failed = results.filter((r) => !r.ok);
    const ok = results.length - failed.length;
    if (failed.length === 0) {
      setBulkOpen(false);
      setSelectedKeys([]);
      setBulkAssignee(undefined);
      message.success(t('ticket.bulkAssignDone', { ok, fail: 0 }));
    } else {
      // Keep the modal open with the failure list; only the failed rows stay selected
      // so OK again retries exactly those.
      setSelectedKeys(failed.map((r) => r.ticketId));
      setBulkErrors(failed.map((r) => codeOf.get(r.ticketId) ?? r.ticketId));
      message.warning(t('ticket.bulkAssignDone', { ok, fail: failed.length }));
    }
  };

  // The Inbox reads its full filter set from the URL; the fixed tabs (mine/pool) pin
  // their view but still honour a URL sort/dir (shareable "newest-first pool" link).
  const urlFilters = filtersFromParams(searchParams);
  // Default order comes from the BE: the status·freshness·urgency band (new/reopen on top,
  // overdue next, closed at the bottom) for inbox/pool/my-tickets. An explicit URL sort
  // (column header / sort control) overrides it.
  // #24: pool/mine are filterable too — their view stays PINNED by the tab (the URL
  // can't override it), while status/category/tag/date come from the URL like Inbox.
  const filters: TicketFilters = filterable
    ? { ...urlFilters, view }
    : { view, sort: urlFilters.sort, dir: urlFilters.dir };
  const { data, isLoading, isError, refetch } = useTickets(page, pageSize, filters);
  const ssa = me?.role === 'ssa';
  const lang = i18n.language === 'en' ? 'en' : 'vi';

  // Live "N vé mới" pill — poll the current filter's total and show a pill when it
  // exceeds the displayed total; clicking pulls the newest in (hr-1 pattern).
  const livePoll = useTicketTotal(filters, 20000);
  const newCount =
    livePoll.data?.total !== undefined && data?.total !== undefined
      ? Math.max(0, livePoll.data.total - data.total)
      : 0;
  const pullNewTickets = () => {
    setPage(1);
    // The band order already floats new/reopen tickets to the TOP, so just clear any manual
    // sort (back to the default band) and refetch — the arrivals land at the top.
    if (filterable) setSearchParams(paramsFromFilters({ ...filters, sort: undefined, dir: undefined }));
    qc.invalidateQueries({ queryKey: ['tickets'] });
    qc.invalidateQueries({ queryKey: ['tickets-poll'] });
  };

  // New-ticket flash: when the SAME page/filter view gains rows it didn't have a moment
  // ago (a poll refetch or "pull new" brought arrivals), briefly highlight those rows so
  // the eye is drawn to what's new. Changing page/filter resets the baseline silently —
  // a fresh page of results is not "new tickets". (Phase 2 optimistic feedback.)
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const flashBaseline = useRef<{ sig: string; ids: Set<string> } | null>(null);
  const viewSig = JSON.stringify({ page, pageSize, filters });
  useEffect(() => {
    const items = data?.items;
    if (!items) return;
    const ids = new Set(items.map((r) => r.id));
    const prev = flashBaseline.current;
    flashBaseline.current = { sig: viewSig, ids };
    if (!prev || prev.sig !== viewSig) return; // first load / context change → establish baseline only
    const fresh = [...ids].filter((id) => !prev.ids.has(id));
    if (fresh.length === 0) return;
    setFlashIds(new Set(fresh));
    const timer = setTimeout(() => setFlashIds(new Set()), 1600);
    return () => clearTimeout(timer);
  }, [data?.items, viewSig]);

  const applyFilters = (next: TicketFilters) => {
    setPage(1);
    setSearchParams(paramsFromFilters(next), { replace: false });
  };
  const isWorklistOrder = !filters.sort || filters.sort === 'worklist';
  // CR-7: reflect the URL sort back into the header arrows (controlled sortOrder) so
  // a shared "?sort=created&dir=asc" link renders with the right arrow lit.
  const sortOrderFor = (col: TicketSort) =>
    filters.sort === col ? (filters.dir === 'asc' ? ('ascend' as const) : ('descend' as const)) : null;

  const columns: ColumnsType<TicketListItem> = [
    {
      // One rich primary cell (avatar + subject + #code on top, requester · time below) —
      // replaces four cramped columns and reads like an email row (v1 inbox redesign).
      title: t('ticket.subject'),
      dataIndex: 'subject',
      ellipsis: true,
      render: (_, r) => {
        // Junk/spam ticket: suppress priority + new badges, surface a single Rác/Spam
        // marker instead so the row reads as "set aside" at a glance.
        const flagged = !!r.isJunk || !!r.isSpamThread;
        const priority = flagged ? [] : r.tags.filter((tg) => tg.kind === 'priority');
        // The subject is always bold (it's the row's headline). "Unclaimed" tickets (open,
        // no assignee — what needs picking up) get an EXTRA-heavy row + blue tint + accent
        // bar via the `row-unread` class below; we key that on assignee/status, NOT on the
        // unreliable first_read_at (no per-user "seen" record exists).
        return (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <Avatar size={38} style={{ background: avatarColor(r.requesterEmail), flexShrink: 0, fontWeight: 600 }}>
              {initialOf(r.requesterEmail)}
            </Avatar>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {r.isJunk && (
                  <Tag color="default" style={{ margin: 0 }}>{t('spam.mark.junkBadge')}</Tag>
                )}
                {r.isSpamThread && (
                  <Tag color="gold" style={{ margin: 0 }}>{t('spam.mark.spamBadge')}</Tag>
                )}
                {!flagged && isNew(r) && (
                  <Tag color="green" style={{ margin: 0 }}>
                    {t('ticket.new')}
                  </Tag>
                )}
                {priority.map((p) => (
                  <Tag key={p.name} icon={<FlagOutlined />} color={p.color ?? 'red'} style={{ margin: 0, fontWeight: 600 }}>
                    {p.name}
                  </Tag>
                ))}
                <Typography.Text strong ellipsis style={{ maxWidth: 480 }}>
                  {r.subject}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                  {displayCode(r.ticketCode, r.projectKey, ssa)}
                </Typography.Text>
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.requesterEmail} ·{' '}
                <Tooltip title={vnTime(r.createdAt)}>{fmtRelative(r.createdAt, lang)}</Tooltip>
              </Typography.Text>
            </div>
          </div>
        );
      },
    },
    {
      title: t('ticket.category'),
      dataIndex: 'category',
      width: 150,
      sorter: true,
      sortOrder: sortOrderFor('category'),
      render: (_, r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <CategoryTag category={r.category} lang={lang} />
          {r.categorySensitive && (
            <Tooltip title={t('ticket.sensitive')}>
              <Tag color="red" icon={<SafetyCertificateOutlined />} style={{ margin: 0 }} />
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      // Combined "tags + who's handling it" cell with an inline manual-tag picker (FR33).
      title: t('ticket.tagsAssignee'),
      key: 'assignee',
      width: 250,
      sorter: true,
      sortOrder: sortOrderFor('assignee'),
      render: (_, r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>
            {r.assignee ? (
              <>
                <UserOutlined style={{ marginRight: 4, color: '#8c8c8c' }} />
                {r.assignee.name}
                <AwayBadge awayFrom={r.assignee.awayFrom} awayTo={r.assignee.awayTo} />
              </>
            ) : (
              <Tag>{t('ticket.pool')}</Tag>
            )}
          </span>
          {!r.isJunk && !r.isSpamThread && (
            <TagCell ticket={r} onChanged={() => qc.invalidateQueries({ queryKey: ['tickets'] })} />
          )}
        </div>
      ),
    },
    // 12.6 (rev 2): the dedicated "Tạo lúc" column is dropped — the created time still
    // shows inline under the subject, so no information is lost and the header row stays
    // lean. Manual sort by created time is no longer offered (worklist order is the
    // default; the closed archive sorts by "Ngày đóng").
    // 12.6: the "Ngày đóng" column is only meaningful for closed tickets, and the
    // default worklist hides closed ones (đơn 8). So it appears ONLY while the user
    // is filtering the closed archive (status includes 'closed'). Open rows in that
    // view (e.g. a mixed status filter) show "—". Sortable → URL sort=closed.
    ...(filters.status?.includes('closed')
      ? ([
          {
            title: t('ticket.closedAt'),
            dataIndex: 'closedAt',
            width: 110,
            sorter: true,
            sortOrder: sortOrderFor('closed'),
            render: (v: string | null) =>
              v ? (
                <Tooltip title={vnTime(v)}>{fmtRelative(v, lang)}</Tooltip>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
        ] as ColumnsType<TicketListItem>)
      : []),
    {
      title: t('ticket.status'),
      dataIndex: 'status',
      width: 150,
      sorter: true,
      sortOrder: sortOrderFor('status'),
      render: (s: string, r) => (
        <Space direction="vertical" size={2}>
          <StatusTag status={s} />
          {r.reopenCount > 0 && s !== 'closed' && <Tag color="volcano">{t('lifecycle.reopened')}</Tag>}
          {r.isOverdue && <Tag color="error">{t('lifecycle.overdueDays', { count: r.overdueDays })}</Tag>}
          {r.snoozeDue && <Tag color="gold">{t('lifecycle.snoozeDue')}</Tag>}
        </Space>
      ),
    },
  ];

  /** Manual column sort → drive the URL `sort`/`dir`; clearing returns to the
   *  shared worklist order (the "Về thứ tự chuẩn" path, FR106). */
  const handleTableChange = (
    _pg: TablePaginationConfig,
    _filters: Record<string, unknown>,
    sorter: SorterResult<TicketListItem> | SorterResult<TicketListItem>[],
    extra: TableCurrentDataSource<TicketListItem>,
  ) => {
    // Only react to a column-header sort. Pagination has its own onChange; without this
    // guard a 'paginate' action would re-run applyFilters and snap back to page 1.
    if (extra.action !== 'sort') return;
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const key = (s?.columnKey ?? s?.field) as string | undefined;
    const col =
      key === 'closedAt'
        ? 'closed'
        : key === 'status' || key === 'category' || key === 'assignee'
          ? (key as TicketSort)
          : undefined;
    const next =
      !col || !s?.order
        ? { ...filters, sort: undefined, dir: undefined }
        : { ...filters, sort: col, dir: s.order === 'ascend' ? ('asc' as const) : ('desc' as const) };
    // Fixed tabs (mine/pool) carry only sort/dir in the URL — their view is pinned
    // by the route, so don't serialize the rest of the filter state.
    applyFilters(filterable ? next : { sort: next.sort, dir: next.dir });
  };

  // Đơn 5: EVERY role may claim from the pool — as long as its ticket.claim
  // capability is on (SSA matrix; CapabilityGuard 403s without it, so no dead
  // button). A member's visible pool rows are already their groups + "Khác".
  const canClaimRole = hasCap(me, 'ticket.claim');
  if (view === 'pool' && canClaimRole) {
    columns.push({
      title: '',
      width: 90,
      render: (_, r) => <ClaimButton ticketId={r.id} onDone={() => message.success(t('ticket.claimed'))} onLose={() => message.warning(t('ticket.claimLost'))} />,
    });
  }

  return (
    <div>
      {/* One toolbar row: the view tabs (with the total as a badge on the active tab —
          no separate "80 vé" tag) on the left; sort / filter / export on the right. */}
      <div
        aria-label={t(titleKey)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}
      >
        <TicketsTabBar activeTotal={data?.total} mb={0} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              {t('manualTicket.button')}
            </Button>
          )}
          {(data?.overdueTotal ?? 0) > 0 && (
            <Tag color="error">{t('lifecycle.overdueCount', { count: data!.overdueTotal })}</Tag>
          )}
          {filterable && (
            <>
              {/* Sort control removed — the worklist (priority) order is the fixed default;
                  filtering covers the rest. */}
              {/* Bộ lọc next to Xuất; Xuất stays last. The button toggles the right column. */}
              <Badge count={activeCount(filters)} size="small">
                <Button
                  icon={<FilterOutlined />}
                  type={filterOpen ? 'primary' : 'default'}
                  onClick={() => setFilterOpen((o) => !o)}
                >
                  {t('reports.filter.button')}
                </Button>
              </Badge>
              <ExportButton onExport={(format) => exportTickets(filters, format)} />
            </>
          )}
        </div>
      </div>
      <div style={{ marginBottom: 12 }} />
      {filterable && <TicketFilterChips value={filters} onChange={applyFilters} />}
      {selectedKeys.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 12,
            padding: '8px 12px',
            background: '#EEF3FA',
            border: '1px solid #D6E2F0',
            borderRadius: 8,
          }}
        >
          <Typography.Text strong>{t('ticket.bulkSelected', { count: selectedKeys.length })}</Typography.Text>
          <Button type="primary" size="small" onClick={() => setBulkOpen(true)}>
            {t('ticket.bulkAssign')}
          </Button>
          <Button size="small" onClick={() => setSelectedKeys([])}>
            {t('ticket.bulkClear')}
          </Button>
        </div>
      )}
      <CreateTicketModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <Modal
        open={bulkOpen}
        title={t('ticket.bulkAssign')}
        onOk={runBulkAssign}
        onCancel={() => {
          setBulkOpen(false);
          setBulkErrors([]);
        }}
        confirmLoading={bulkBusy}
        okButtonProps={{ disabled: !bulkAssignee }}
        okText={bulkErrors.length > 0 ? t('ticket.bulkRetryFailed') : undefined}
      >
        <Select
          style={{ width: '100%' }}
          placeholder={t('reports.filter.assignee')}
          value={bulkAssignee}
          onChange={setBulkAssignee}
          showSearch
          optionFilterProp="label"
          options={(opts?.assignees ?? []).filter((a) => !a.disabled).map((a) => ({ value: a.id, label: a.name }))}
        />
        {bulkBusy && (
          <Progress
            percent={100}
            status="active"
            showInfo={false}
            style={{ marginTop: 12 }}
          />
        )}
        {!bulkBusy && bulkErrors.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message={t('ticket.bulkFailedList', { count: bulkErrors.length })}
            description={bulkErrors.join(', ')}
          />
        )}
      </Modal>
      {/* hr-1 layout: the list is the left column; the filter panel is a right column
          that the toggle reveals, pushing the table left (no overlay popup). On narrow
          screens the row wraps, so the panel drops below the table at full width. */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
      {/* Floating "N vé mới" pill — appears when the poll outruns the displayed page. */}
      {newCount > 0 && (
        <div style={{ position: 'sticky', top: 8, zIndex: 5, height: 0, textAlign: 'center' }}>
          <Button
            shape="round"
            type="primary"
            icon={<ArrowUpOutlined />}
            onClick={pullNewTickets}
            style={{ boxShadow: '0 4px 16px rgba(15,27,51,0.22)' }}
          >
            {t('ticket.newTicketsPill', { count: newCount })}
          </Button>
        </div>
      )}
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
        <TableSkeleton rows={8} />
      ) : (
      <Table<TicketListItem>
        // Remount when the side panel toggles so the sticky header re-measures column
        // widths against the new container width (otherwise header/body columns desync).
        key={filterOpen ? 'with-filter' : 'no-filter'}
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        rowSelection={canBulkAssign ? { selectedRowKeys: selectedKeys, onChange: setSelectedKeys } : undefined}
        tableLayout="fixed"
        scroll={{ x: 880 }}
        onChange={handleTableChange}
        locale={{ emptyText: <EmptyState art={<InboxZeroArt />} description={t('ticket.empty')} /> }}
        // Zebra striping so adjacent rows are easy to tell apart at a glance.
        rowClassName={(r, index) =>
          [
            index % 2 === 1 ? 'row-zebra' : '',
            r.isJunk || r.isSpamThread ? 'row-muted' : '',
            !r.isJunk && !r.isSpamThread && !r.assignee && r.status === 'open' ? 'row-unread' : '',
            flashIds.has(r.id) ? 'row-flash' : '',
          ]
            .filter(Boolean)
            .join(' ')
        }
        onRow={(r) => ({
          onClick: (e) => {
            // Don't navigate when the click came from the claim button or the
            // row-selection checkbox (selecting must not open the ticket).
            if ((e.target as HTMLElement).closest('button, .ant-checkbox, .ant-table-selection-column')) return;
            navigate(`/tickets/${r.id}`);
          },
          // Overdue rows get a soft-red background so the worklist screams at a glance (5.6).
          // Unclaimed (open, no assignee) rows get a blue tint — "needs picking up".
          style: {
            cursor: 'pointer',
            background: r.isOverdue
              ? palette.errorSoft
              : !r.isJunk && !r.isSpamThread && !r.assignee && r.status === 'open'
                ? palette.infoSoft
                : undefined,
          },
        })}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          // Default 20/page, openable up to 100 (đơn 11) — keep the pager (and its
          // size changer) visible even when everything fits on one page.
          pageSizeOptions: [20, 50, 100],
          hideOnSinglePage: false,
          position: ['bottomLeft'],
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
            // Selection is per visible page: rows picked on page 1 must not ride
            // along invisibly into a bulk-assign made from page 2.
            setSelectedKeys([]);
          },
        }}
          />
      )}
        </div>
        {filterable && filterOpen && (
          <TicketFilterPanel
            value={filters}
            onChange={applyFilters}
            onReset={() => applyFilters({ view })}
            isWorklistOrder={isWorklistOrder}
          />
        )}
      </div>
    </div>
  );
}

/** Inline manual-tag picker for a worklist row: shows applied (non-priority) tags as
 *  chips + a popover to toggle the project's manual tags. Tags are fetched lazily when
 *  the popover opens (FR33). Priority tags live in the subject cell, so they're excluded. */
function TagCell({ ticket, onChanged }: { ticket: TicketListItem; onChanged: () => void }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const { data: avail = [], refetch, isLoading } = useTicketTags(ticket.id, open);
  const normal = ticket.tags.filter((tg) => tg.kind !== 'priority');
  // Tagging from the list is gated like the detail: not on a closed ticket, and only the
  // assignee or an Admin/SSA (the list row has no categoryId to check TL-in-group — a TL
  // tags from the ticket detail instead). The server is the real guard.
  const isAdmin = me?.role === 'ssa' || me?.role === 'admin';
  const canTag = ticket.status !== 'closed' && (isAdmin || ticket.assignee?.id === me?.user.id);

  const toggle = async (tag: AvailableTag) => {
    setBusy(tag.id);
    try {
      if (tag.applied) await removeTicketTag(ticket.id, tag.id);
      else await addTicketTag(ticket.id, tag.id);
      await refetch();
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const manual = avail.filter((tg) => tg.kind === 'manual');
  // System-applied tags (auto signals + priority keywords) shown read-only so the user
  // can SEE them in the picker — they can't be toggled by hand ("thiếu nhãn tự động").
  const autoApplied = avail.filter((tg) => tg.kind !== 'manual' && tg.applied);
  const picker = (
    <div style={{ width: 240, maxHeight: 320, overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 12 }}>
          <Spin size="small" />
        </div>
      ) : (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {t('ticket.manualTags')}
          </Typography.Text>
          {manual.length === 0 ? (
            <div style={{ padding: '4px 6px' }}>
              <Typography.Text type="secondary">{t('ticket.noManualTags')}</Typography.Text>
            </div>
          ) : (
            manual.map((tg) => (
              <div
                key={tg.id}
                onClick={() => toggle(tg)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '5px 6px',
                  cursor: 'pointer',
                  borderRadius: 6,
                }}
              >
                <Tag color={tg.color ?? 'default'} style={{ margin: 0 }}>
                  {tg.name}
                </Tag>
                {busy === tg.id ? <Spin size="small" /> : tg.applied ? <CheckOutlined style={{ color: palette.success }} /> : null}
              </div>
            ))
          )}
          {autoApplied.length > 0 && (
            <>
              <div style={{ borderTop: '1px solid #f0f0f0', margin: '8px 0' }} />
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {t('ticket.autoTagsSection')}
              </Typography.Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, padding: '0 6px' }}>
                {autoApplied.map((tg) => (
                  <Tag key={tg.id} color={tg.color ?? 'default'} icon={<RobotOutlined />} style={{ margin: 0 }}>
                    {tg.name}
                  </Tag>
                ))}
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6, padding: '0 6px' }}>
                {t('ticket.autoTagsHint')}
              </Typography.Text>
            </>
          )}
        </>
      )}
    </div>
  );

  return (
    <Space size={4} wrap>
      {normal.map((tg) => (
        <Tag
          key={tg.name}
          color={tg.color ?? 'default'}
          icon={tg.kind === 'auto' ? <RobotOutlined /> : undefined}
          style={{ margin: 0 }}
        >
          {tg.name}
        </Tag>
      ))}
      {canTag && (
        <Popover
          content={picker}
          trigger="click"
          open={open}
          onOpenChange={setOpen}
          placement="bottomLeft"
          title={t('ticket.addTag')}
        >
          <Button
            size="small"
            type="dashed"
            icon={<TagsOutlined />}
            onClick={(e) => e.stopPropagation()}
            // Hover-reveal (P2): visible on row hover / while its picker is open —
            // a dashed button on EVERY row read as noise. See index.css.
            className={`tag-add-btn${open ? ' tag-add-btn--open' : ''}`}
          >
            {t('ticket.tag')}
          </Button>
        </Popover>
      )}
    </Space>
  );
}

/** Self-contained claim button so each row gets its own mutation + race handling.
 *  Claim from "Khác" may demand a category choice (đơn 5) — a small picker modal. */
function ClaimButton({ ticketId, onDone, onLose }: { ticketId: string; onDone: () => void; onLose: () => void }) {
  const { t } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'vi';
  const claim = useClaim(ticketId);
  const [choices, setChoices] = useState<CategoryOption[] | null>(null);
  const onClaimed = (res: ClaimResponse) => {
    if ('needsCategory' in res) setChoices(res.options);
    else onDone();
  };
  return (
    <>
      <Button
        size="small"
        type="primary"
        loading={claim.isPending}
        onClick={() => claim.mutate({}, { onSuccess: onClaimed, onError: onLose })}
      >
        {t('ticket.claim')}
      </Button>
      <Modal open={!!choices} title={t('ticket.pickCategory')} footer={null} onCancel={() => setChoices(null)}>
        <Select
          style={{ width: '100%' }}
          placeholder={t('ticket.pickCategory')}
          onChange={(v: number) => {
            setChoices(null);
            claim.mutate({ categoryId: v }, { onSuccess: onClaimed, onError: onLose });
          }}
          options={(choices ?? []).map((c) => ({ value: c.id, label: lang === 'en' ? c.nameEn : c.nameVi }))}
        />
      </Modal>
    </>
  );
}
