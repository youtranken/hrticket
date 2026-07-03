import { useState, type Key } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Table, Tag, Typography, Empty, Space, Button, Tooltip, Modal, Select, Avatar, Popover, Spin, Badge, Alert, App as AntApp } from 'antd';
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
import { useMe } from '../../lib/auth';
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
import { TicketFilterPanel, TicketFilterChips, activeCount } from './TicketFilterBar';
import { TicketsTabBar } from './TicketsTabBar';
import { CreateTicketModal } from './CreateTicketModal';
import { filtersFromParams, paramsFromFilters } from './filterUrl';
import { ExportButton } from '../reports/ExportButton';
import { exportTickets } from '../../lib/export';
import i18n from '../../i18n';
import { palette } from '../../theme';

function vnTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
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

/** "2 giờ trước" / "2 hours ago" — scannable list time; exact time goes in a tooltip. */
function relTime(iso: string, lang: 'vi' | 'en'): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const min = Math.round(diffMs / 60000);
  if (Math.abs(min) < 60) return rtf.format(-min, 'minute');
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return rtf.format(-hr, 'hour');
  const day = Math.round(hr / 24);
  if (Math.abs(day) < 30) return rtf.format(-day, 'day');
  return rtf.format(-Math.round(day / 30), 'month');
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
  const [filterOpen, setFilterOpen] = useState(false); // right-column filter panel toggle
  const [createOpen, setCreateOpen] = useState(false); // manual "new ticket" modal
  // Manual ticket creation is for the people who process them — project Admin / TL /
  // Member. SSA (cross-project superuser) doesn't open a single project's tickets.
  const canCreate = !!me && me.role !== 'ssa';

  const runBulkAssign = async () => {
    if (!bulkAssignee) return;
    setBulkBusy(true);
    let ok = 0;
    let fail = 0;
    for (const id of selectedKeys) {
      try {
        const res = await api<{ needsCategory?: true }>(`/tickets/${id}/assign`, {
          method: 'POST',
          body: JSON.stringify({ assigneeId: bulkAssignee }),
        });
        // A "Khác" ticket needing re-classification returns HTTP 200 `{needsCategory}` but is
        // NOT actually assigned — count it as a failure, not a success (FE#2).
        if (res && typeof res === 'object' && 'needsCategory' in res) fail += 1;
        else ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBulkBusy(false);
    setBulkOpen(false);
    setSelectedKeys([]);
    setBulkAssignee(undefined);
    await qc.invalidateQueries({ queryKey: ['tickets'] });
    await qc.invalidateQueries({ queryKey: ['tickets-poll'] });
    message.success(t('ticket.bulkAssignDone', { ok, fail }));
  };

  // The Inbox reads its full filter set from the URL; the fixed tabs (mine/pool) pin
  // their view but still honour a URL sort/dir (shareable "newest-first pool" link).
  const urlFilters = filtersFromParams(searchParams);
  // Default order comes from the BE: the status·freshness·urgency band (new/reopen on top,
  // overdue next, closed at the bottom) for inbox/pool/my-tickets. An explicit URL sort
  // (column header / sort control) overrides it.
  const filters: TicketFilters = filterable
    ? { view: 'all', ...urlFilters }
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
                <Tooltip title={vnTime(r.createdAt)}>{relTime(r.createdAt, lang)}</Tooltip>
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
        <span>
          {r.category ? r.category[lang] : '—'}
          {r.categorySensitive && (
            <Tooltip title={t('ticket.sensitive')}>
              <Tag color="red" icon={<SafetyCertificateOutlined />} style={{ marginLeft: 4 }} />
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
    {
      // CR-7: the v1 redesign folded the created time into the subject cell and lost
      // the sortable header with it — a slim dedicated column brings manual
      // newest/oldest-first back (handleTableChange → URL sort=created).
      title: t('ticket.createdAt'),
      dataIndex: 'createdAt',
      width: 110,
      sorter: true,
      sortOrder: sortOrderFor('created'),
      render: (v: string) => <Tooltip title={vnTime(v)}>{relTime(v, lang)}</Tooltip>,
    },
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
      key === 'createdAt'
        ? 'created'
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

  // Đơn 5: EVERY role may claim from the pool now — Admin/SSA/TL pick up any pool
  // (incl. "Khác"); a member's visible pool rows are already their groups + "Khác".
  const canClaimRole = !!me;
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
        onCancel={() => setBulkOpen(false)}
        confirmLoading={bulkBusy}
        okButtonProps={{ disabled: !bulkAssignee }}
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
      </Modal>
      {/* hr-1 layout: the list is the left column; the filter panel is a right column
          that the toggle reveals, pushing the table left (no overlay popup). */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
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
      <Table<TicketListItem>
        // Remount when the side panel toggles so the sticky header re-measures column
        // widths against the new container width (otherwise header/body columns desync).
        key={filterOpen ? 'with-filter' : 'no-filter'}
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
        tableLayout="fixed"
        scroll={{ x: 880 }}
        onChange={handleTableChange}
        locale={{ emptyText: <Empty description={t('ticket.empty')} /> }}
        // Zebra striping so adjacent rows are easy to tell apart at a glance.
        rowClassName={(r, index) =>
          [
            index % 2 === 1 ? 'row-zebra' : '',
            r.isJunk || r.isSpamThread ? 'row-muted' : '',
            !r.isJunk && !r.isSpamThread && !r.assignee && r.status === 'open' ? 'row-unread' : '',
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
              ? '#fff1f0'
              : !r.isJunk && !r.isSpamThread && !r.assignee && r.status === 'open'
                ? '#eef4ff'
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
        </div>
        {filterable && filterOpen && (
          <TicketFilterPanel
            value={filters}
            onChange={applyFilters}
            onReset={() => applyFilters({ view: 'all' })}
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
                {busy === tg.id ? <Spin size="small" /> : tg.applied ? <CheckOutlined style={{ color: '#1F9D6B' }} /> : null}
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
