import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Col, Row, Segmented, Select, Table, Typography, Space, Empty, Button, Tag } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  FieldTimeOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { EChart } from './EChart';
import { ExportButton } from './ExportButton';
import { exportReport } from '../../lib/export';
import {
  useReportSummary,
  useReportByTime,
  useReportByCategory,
  useReportByStaff,
  type ReportGranularity,
  type ReportRange,
  type CategoryRow,
  type StaffRow,
  type TimeBucket,
} from '../../lib/reports';
import { useMe } from '../../lib/auth';
import i18n from '../../i18n';
import { palette } from '../../theme';
import { CountUp } from '../../components/CountUp';

type PeriodKind = 'year' | 'quarter' | 'month' | 'custom';

const C = {
  created: '#3E63DD',
  handled: '#2E9E6F',
  overdue: '#D64545',
  status: {
    open: palette.primary,
    assigned: '#7AA7E8',
    inProgress: '#3E63DD',
    pending: '#D97706',
    resolved: '#2E9E6F',
    closed: '#B9C4D6',
  },
} as const;

/** VN 'YYYY-MM-DD' for `d`. */
function vnDay(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}
const pad = (n: number) => String(n).padStart(2, '0');

/** Same calendar date one year earlier (Feb-29 clamps to Feb-28). */
function minusOneYear(d: string): string {
  const shifted = `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  return shifted.endsWith('-02-29') ? shifted.replace('-02-29', '-02-28') : shifted;
}

/** VN 'YYYY-MM-DD' for today minus `n` days. */
function vnDaysAgo(n: number): string {
  return vnDay(new Date(Date.now() - n * 86_400_000));
}

/** [from, to] for the picked year + sub-period. */
function rangeFor(year: number, kind: PeriodKind, quarter: number, month: number): { from: string; to: string } {
  if (kind === 'quarter') {
    const m0 = (quarter - 1) * 3 + 1;
    const last = new Date(year, m0 + 2, 0).getDate();
    return { from: `${year}-${pad(m0)}-01`, to: `${year}-${pad(m0 + 2)}-${pad(last)}` };
  }
  if (kind === 'month') {
    const last = new Date(year, month, 0).getDate();
    return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
  }
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** Tiny inline sparkline (no ECharts overhead for 4 mini charts). */
function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div style={{ height: 26 }} />;
  const max = Math.max(...values, 1);
  const W = 96;
  const H = 26;
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - 4 - (v / max) * (H - 8)).toFixed(1)}`);
  const [lx, ly] = pts[pts.length - 1]!.split(',');
  return (
    <svg width={W} height={H} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} />
      <circle cx={lx} cy={ly} r={2.5} fill={color} />
    </svg>
  );
}

function DeltaChip({ text, tone }: { text: string; tone: 'up' | 'down' | 'flat' }) {
  const style =
    tone === 'up'
      ? { color: C.handled, background: '#E7F5EE' }
      : tone === 'down'
        ? { color: C.overdue, background: '#FBEAEA' }
        : { color: palette.textSecondary, background: '#EEF1F6' };
  return (
    <span style={{ ...style, fontSize: 12, fontWeight: 600, borderRadius: 999, padding: '2px 8px' }}>{text}</span>
  );
}

function KpiCard({
  icon,
  tint,
  color,
  label,
  value,
  valueColor,
  sub,
  delta,
  spark,
  sparkColor,
}: {
  icon: React.ReactNode;
  tint: string;
  color: string;
  label: string;
  value: React.ReactNode;
  valueColor?: string;
  sub: React.ReactNode;
  delta?: { text: string; tone: 'up' | 'down' | 'flat' };
  spark?: number[];
  sparkColor?: string;
}) {
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: tint,
            color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 19,
          }}
        >
          {icon}
        </span>
        {delta && <DeltaChip text={delta.text} tone={delta.tone} />}
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12.5, color: palette.textSecondary }}>{label}</div>
        <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.15, color: valueColor, fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </div>
        <div style={{ fontSize: 12, color: palette.textSecondary, minHeight: 18 }}>{sub}</div>
      </div>
      {spark && sparkColor ? <Spark values={spark} color={sparkColor} /> : <div style={{ height: 26 }} />}
    </Card>
  );
}

/**
 * Report dashboard v2 (redesign 3/7/2026, on top of Story 10.3 / đơn 13).
 * Year picker (old years stay queryable — numbers are computed live from tickets),
 * 4 KPI cards with same-period-last-year deltas, created-vs-handled trend,
 * current status distribution, per-category stacked bars, staff scoreboard with
 * handling-time metrics, and a quality strip. Admin/TL can slice to one staff
 * member; a member lands here too but is BE-pinned to a self report (no staff
 * table, no user filter). Every drill-through is a plain /inbox link so the
 * numbers stay auditable against the worklist.
 */
export function ReportsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMe();
  const isMember = me.data?.role === 'member';
  const lang = i18n.language === 'en' ? 'en' : 'vi';

  const today = vnDay(new Date());
  const curYear = Number(today.slice(0, 4));
  const curMonth = Number(today.slice(5, 7));

  const [year, setYear] = useState(curYear);
  const [periodKind, setPeriodKind] = useState<PeriodKind>('year');
  const [quarter, setQuarter] = useState(Math.ceil(curMonth / 3));
  const [month, setMonth] = useState(curMonth);
  // #57: free date range (defaults to the last 30 days when first opened).
  const [customFrom, setCustomFrom] = useState(() => vnDaysAgo(29));
  const [customTo, setCustomTo] = useState(today);
  const [granularity, setGranularity] = useState<ReportGranularity>('month');
  const [staffFilter, setStaffFilter] = useState<string | undefined>(undefined);
  const [showTimeTable, setShowTimeTable] = useState(false);

  const range = useMemo(() => {
    if (periodKind !== 'custom') return rangeFor(year, periodKind, quarter, month);
    // A half-typed inverted range would 500-trap the BE zod guard — swap silently.
    return customFrom <= customTo
      ? { from: customFrom, to: customTo }
      : { from: customTo, to: customFrom };
  }, [year, periodKind, quarter, month, customFrom, customTo]);
  // "So cùng kỳ": recompute the SAME period for year−1 (not a string shift — that
  // would clamp Feb to the wrong month-end across leap years, review 3/7). A custom
  // range shifts both bounds back one year (Feb-29 clamped).
  const prevRange = useMemo(
    () =>
      periodKind === 'custom'
        ? { from: minusOneYear(range.from), to: minusOneYear(range.to) }
        : rangeFor(year - 1, periodKind, quarter, month),
    [year, periodKind, quarter, month, range.from, range.to],
  );
  const summaryRange: ReportRange = {
    ...range,
    assigneeId: staffFilter,
    prevFrom: prevRange.from,
    prevTo: prevRange.to,
  };
  const timeRange: ReportRange = { ...range, granularity, assigneeId: staffFilter };
  const catRange: ReportRange = { ...range, assigneeId: staffFilter };

  const summary = useReportSummary(summaryRange);
  const time = useReportByTime(timeRange);
  const category = useReportByCategory(catRange);
  // The staff table stays UNFILTERED — it is itself the per-user comparison and
  // it feeds the filter dropdown. Hidden (and not fetched) for a member.
  const staff = useReportByStaff(range, !!me.data && !isMember);

  const s = summary.data;
  const buckets = time.data?.buckets ?? [];
  const cats = category.data?.categories ?? [];
  const staffRows = staff.data?.staff ?? [];
  const staffOptions = staffRows
    .filter((r): r is StaffRow & { assigneeId: string } => r.assigneeId !== null)
    .map((r) => ({ value: r.assigneeId, label: r.name ?? r.assigneeId }));

  const years = useMemo(() => {
    const min = s?.minYear ?? curYear;
    const list: number[] = [];
    for (let y = Math.max(curYear, year); y >= Math.min(min, year); y--) list.push(y);
    return list;
  }, [s?.minYear, curYear, year]);

  // KPI deltas vs same period last year (custom range → same dates a year earlier).
  const prevYearLabel = periodKind === 'custom' ? Number(range.from.slice(0, 4)) - 1 : year - 1;
  const handledDelta = (() => {
    if (!s?.prev || s.prev.handled === 0) return undefined;
    const pct = Math.round(((s.handled.total - s.prev.handled) / s.prev.handled) * 100);
    return {
      text: `${pct >= 0 ? '+' : ''}${pct}% ${t('reports.v2.vsPrev', { y: prevYearLabel })}`,
      tone: pct >= 0 ? ('up' as const) : ('down' as const),
    };
  })();
  const avgDelta = (() => {
    if (s?.resolution.avgDays == null || s.prev?.avgDays == null) return undefined;
    const diff = s.resolution.avgDays - s.prev.avgDays;
    const d = Math.abs(diff).toFixed(1);
    if (Math.abs(diff) < 0.05)
      return { text: `≈ ${t('reports.v2.vsPrev', { y: prevYearLabel })}`, tone: 'flat' as const };
    return diff < 0
      ? { text: t('reports.v2.faster', { d }), tone: 'up' as const }
      : { text: t('reports.v2.slower', { d }), tone: 'down' as const };
  })();

  const catLabel = (c: CategoryRow) =>
    c.categoryId === null ? t('reports.dashboard.uncategorized') : (lang === 'en' ? c.nameEn : c.nameVi) ?? '—';

  const drill = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    p.set('createdFrom', range.from);
    p.set('createdTo', range.to);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    // Pin the drill-through to whatever the numbers were sliced to: the active user
    // filter, or — for a member — THEMSELVES (their dashboard is BE-pinned to self,
    // an unpinned link would open the whole group's list and never reconcile).
    const pin = isMember ? me.data?.user.id : staffFilter;
    if (pin && !extra.assigneeId && !extra.view) p.set('assigneeId', pin);
    navigate(`/inbox?${p.toString()}`);
  };

  const statusRows = s
    ? ([
        ['open', s.status.open, C.status.open],
        ['assigned', s.status.assigned, C.status.assigned],
        ['in_progress', s.status.inProgress, C.status.inProgress],
        ['pending', s.status.pending, C.status.pending],
        ['resolved', s.status.resolved, C.status.resolved],
        ['closed', s.status.closed, C.status.closed],
      ] as const)
    : [];
  const pct = (n: number) => (s && s.total > 0 ? `${((100 * n) / s.total).toFixed(1).replace(/\.0$/, '')}%` : '0%');

  const maxCreated = Math.max(...cats.map((c) => c.created), 1);
  const reopenPct = s && s.total > 0 ? (100 * s.quality.reopenedAll) / s.total : 0;
  const fmtDays = (d: number | null | undefined) =>
    d == null ? '—' : `${d.toFixed(1).replace('.', lang === 'vi' ? ',' : '.')} ${t('reports.v2.days')}`;
  // P2: thousands grouping on the KPI figures (locale-aware).
  const nf = new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'vi-VN');
  const num = (v: number | undefined): string => (v === undefined ? '…' : nf.format(v));

  return (
    <div>
      {/* ── header: year + sub-period + staff filter ─────────────────── */}
      <Space align="center" style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t('reports.dashboard.title')}
        </Typography.Title>
        <Space wrap>
          {!isMember && (
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('reports.filterUser')}
              style={{ minWidth: 180 }}
              value={staffFilter}
              onChange={(v) => setStaffFilter(v)}
              options={staffOptions}
            />
          )}
          {periodKind !== 'custom' && (
            <Select
              value={year}
              onChange={(v) => setYear(v)}
              style={{ width: 92 }}
              options={years.map((y) => ({ value: y, label: String(y) }))}
            />
          )}
          <Segmented<PeriodKind>
            value={periodKind}
            onChange={(v) => setPeriodKind(v)}
            options={[
              { label: t('reports.v2.fullYear'), value: 'year' },
              { label: t('reports.v2.quarter'), value: 'quarter' },
              { label: t('reports.v2.month'), value: 'month' },
              { label: t('reports.v2.custom'), value: 'custom' },
            ]}
          />
          {periodKind === 'quarter' && (
            <Select
              value={quarter}
              onChange={(v) => setQuarter(v)}
              style={{ width: 74 }}
              options={[1, 2, 3, 4].map((q) => ({ value: q, label: `Q${q}` }))}
            />
          )}
          {periodKind === 'month' && (
            <Select
              value={month}
              onChange={(v) => setMonth(v)}
              style={{ width: 110 }}
              options={Array.from({ length: 12 }, (_, i) => ({
                value: i + 1,
                label: `${t('reports.v2.month')} ${i + 1}`,
              }))}
            />
          )}
          {periodKind === 'custom' && (
            <>
              {/* Native date inputs, same convention as the rest of the app (#57). */}
              <input
                type="date"
                className="ant-input"
                style={{ width: 148, height: 32, padding: '0 8px' }}
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <span style={{ color: '#8A94A6' }}>–</span>
              <input
                type="date"
                className="ant-input"
                style={{ width: 148, height: 32, padding: '0 8px' }}
                value={customTo}
                min={customFrom || undefined}
                max={today}
                onChange={(e) => setCustomTo(e.target.value)}
              />
              <Button
                size="small"
                onClick={() => {
                  setCustomFrom(vnDaysAgo(6));
                  setCustomTo(today);
                }}
              >
                {t('reports.v2.last7')}
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setCustomFrom(vnDaysAgo(29));
                  setCustomTo(today);
                }}
              >
                {t('reports.v2.last30')}
              </Button>
            </>
          )}
        </Space>
      </Space>

      {/* ── KPI cards ────────────────────────────────────────────────── */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={6} className="stagger-item" style={{ ['--i' as never]: 0 }}>
          <KpiCard
            icon={<CheckCircleOutlined />}
            tint="#E4F6EE"
            color="#1F9D6B"
            label={t('reports.v2.handled')}
            value={<CountUp value={s?.handled.total} format={num} />}
            sub={s ? t('reports.v2.handledSub', { r: s.handled.resolved, c: s.handled.closed }) : ''}
            delta={handledDelta}
            spark={buckets.map((b) => b.handled)}
            sparkColor={C.handled}
          />
        </Col>
        <Col xs={12} lg={6} className="stagger-item" style={{ ['--i' as never]: 1 }}>
          <KpiCard
            icon={<ClockCircleOutlined />}
            tint="#E7F0FB"
            color="#3E63DD"
            label={t('reports.v2.active')}
            value={<CountUp value={s?.active.total} format={num} />}
            sub={s ? t('reports.v2.activeSub', { r: s.active.reopened, p: s.active.pending }) : ''}
            spark={buckets.map((b) => b.open)}
            sparkColor={C.created}
          />
        </Col>
        <Col xs={12} lg={6} className="stagger-item" style={{ ['--i' as never]: 2 }}>
          <KpiCard
            icon={<WarningOutlined />}
            tint="#FBEAEA"
            color="#D64545"
            label={t('reports.metric.overdue')}
            value={<CountUp value={s?.overdue.total} format={num} />}
            valueColor={s && s.overdue.total > 0 ? C.overdue : undefined}
            sub={
              s
                ? s.overdue.total > 0
                  ? t('reports.v2.overdueSub', { d: s.overdue.maxDays })
                  : t('reports.v2.noOverdue')
                : ''
            }
            spark={buckets.map((b) => b.overdue)}
            sparkColor={C.overdue}
          />
        </Col>
        <Col xs={12} lg={6} className="stagger-item" style={{ ['--i' as never]: 3 }}>
          <KpiCard
            icon={<FieldTimeOutlined />}
            tint="#EFEBFA"
            color="#6E5BAA"
            label={t('reports.v2.avgDays')}
            value={
              s?.resolution.avgDays == null ? (
                '—'
              ) : (
                <>
                  {s.resolution.avgDays.toFixed(1).replace('.', lang === 'vi' ? ',' : '.')}{' '}
                  <span style={{ fontSize: 15, fontWeight: 600, color: palette.textSecondary }}>{t('reports.v2.days')}</span>
                </>
              )
            }
            sub={t('reports.v2.avgDaysSub')}
            delta={avgDelta}
          />
        </Col>
      </Row>

      {/* ── trend: created vs handled ────────────────────────────────── */}
      <Card
        title={t('reports.dashboard.byTime')}
        extra={
          <Space>
            <Segmented<ReportGranularity>
              value={granularity}
              onChange={(v) => setGranularity(v)}
              options={[
                { label: t('reports.granularity.week'), value: 'week' },
                { label: t('reports.granularity.month'), value: 'month' },
                { label: t('reports.granularity.year'), value: 'year' },
              ]}
            />
            <Button size="small" onClick={() => setShowTimeTable((v) => !v)}>
              {showTimeTable ? t('reports.v2.hideTable') : t('reports.v2.showTable')}
            </Button>
            <ExportButton onExport={(f) => exportReport('by-time', timeRange, f)} />
          </Space>
        }
        style={{ marginBottom: 16 }}
        loading={time.isLoading}
      >
        {buckets.length === 0 ? (
          <Empty description={t('reports.dashboard.noData')} />
        ) : (
          <>
            <EChart
              option={{
                tooltip: { trigger: 'axis' },
                legend: {
                  data: [t('reports.metric.created'), t('reports.metric.handled'), t('reports.metric.overdue')],
                },
                grid: { left: 44, right: 16, top: 40, bottom: 28 },
                xAxis: { type: 'category', data: buckets.map((b) => b.bucket) },
                yAxis: { type: 'value', minInterval: 1 },
                series: [
                  {
                    name: t('reports.metric.created'),
                    type: 'line',
                    data: buckets.map((b) => b.created),
                    color: C.created,
                    symbolSize: 6,
                  },
                  {
                    name: t('reports.metric.handled'),
                    type: 'line',
                    data: buckets.map((b) => b.handled),
                    color: C.handled,
                    symbolSize: 6,
                    areaStyle: { opacity: 0.08 },
                  },
                  {
                    // Overdue as red MARKS (not a line hugging zero): only buckets
                    // that still hold overdue tickets get a dot, at their count.
                    name: t('reports.metric.overdue'),
                    type: 'line',
                    data: buckets.map((b) => (b.overdue > 0 ? b.overdue : null)),
                    color: C.overdue,
                    lineStyle: { opacity: 0 },
                    symbolSize: 9,
                  },
                ],
              }}
            />
            {showTimeTable && (
              <Table<TimeBucket>
                rowKey="bucket"
                size="small"
                pagination={false}
                dataSource={buckets}
                columns={timeColumns(t, granularity)}
                style={{ marginTop: 12 }}
              />
            )}
          </>
        )}
      </Card>

      {/* ── current states + per-category ────────────────────────────── */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={10}>
          <Card title={`${t('reports.v2.statusTitle')} ${year}`} loading={summary.isLoading} style={{ height: '100%' }}>
            {!s || s.total === 0 ? (
              <Empty description={t('reports.dashboard.noData')} />
            ) : (
              <>
                <div style={{ display: 'flex', height: 24, borderRadius: 7, overflow: 'hidden', margin: '6px 0 14px' }}>
                  {statusRows
                    .filter(([, n]) => n > 0)
                    .map(([k, n, color]) => (
                      <span key={k} style={{ width: pct(n), background: color }} />
                    ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {statusRows.map(([k, n, color]) => (
                    <a
                      key={k}
                      onClick={() => drill({ status: k })}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'inherit', fontSize: 13.5 }}
                    >
                      <i style={{ width: 10, height: 10, borderRadius: 3, background: color, flex: 'none' }} />
                      {t(`status.${k}`)}
                      <b style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{n}</b>
                      <span style={{ width: 48, textAlign: 'right', color: palette.textSecondary, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                        {pct(n)}
                      </span>
                    </a>
                  ))}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
                  {t('reports.v2.rowClickHint')}
                </Typography.Text>
              </>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card
            title={t('reports.dashboard.byCategory')}
            extra={<ExportButton onExport={(f) => exportReport('by-category', catRange, f)} />}
            loading={category.isLoading}
            style={{ height: '100%' }}
          >
            {cats.length === 0 ? (
              <Empty description={t('reports.dashboard.noData')} />
            ) : (
              <>
                <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: palette.textSecondary, marginBottom: 12 }}>
                  <span><i style={legendDot(C.handled)} />{t('reports.metric.handled')}</span>
                  <span><i style={legendDot(C.created)} />{t('reports.v2.active')}</span>
                  <span><i style={legendDot(C.overdue)} />{t('reports.metric.overdue')}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {cats.map((c) => {
                    const activeSafe = Math.max(0, c.open - c.overdue);
                    const seg = (n: number) => `${c.created > 0 ? (100 * n) / c.created : 0}%`;
                    return (
                      <a
                        key={String(c.categoryId)}
                        onClick={() => c.categoryId !== null && drill({ categoryId: String(c.categoryId) })}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '96px 1fr 44px',
                          gap: 12,
                          alignItems: 'center',
                          color: 'inherit',
                        }}
                      >
                        <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {catLabel(c)}
                        </span>
                        <span
                          style={{
                            display: 'flex',
                            height: 18,
                            borderRadius: 5,
                            overflow: 'hidden',
                            background: '#EEF1F6',
                            width: `${(100 * c.created) / maxCreated}%`,
                            minWidth: 40,
                          }}
                        >
                          <span style={{ width: seg(c.handled), background: C.handled }} />
                          <span style={{ width: seg(activeSafe), background: C.created }} />
                          <span style={{ width: seg(c.overdue), background: C.overdue }} />
                        </span>
                        <b style={{ fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.created}</b>
                      </a>
                    );
                  })}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
                  {t('reports.clickToFilter')}
                </Typography.Text>
              </>
            )}
          </Card>
        </Col>
      </Row>

      {/* ── staff scoreboard (hidden for members: single-row self) ───── */}
      {!isMember && (
        <Card
          title={t('reports.v2.staffTitle')}
          extra={<ExportButton onExport={(f) => exportReport('by-staff', range, f)} />}
          loading={staff.isLoading}
          style={{ marginBottom: 16 }}
        >
          {staffRows.length === 0 ? (
            <Empty description={t('reports.dashboard.noData')} />
          ) : (
            <>
              <Table<StaffRow>
                rowKey={(r) => r.assigneeId ?? 'pool'}
                size="small"
                pagination={false}
                dataSource={staffRows}
                columns={staffColumns(t, fmtDays)}
                onRow={(r) => ({
                  onClick: () => (r.assigneeId ? drill({ assigneeId: r.assigneeId }) : drill({ view: 'pool' })),
                  style: { cursor: 'pointer' },
                })}
                scroll={{ x: 720 }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                {t('reports.v2.rowClickHint')}
              </Typography.Text>
            </>
          )}
        </Card>
      )}

      {/* ── quality strip ────────────────────────────────────────────── */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card>
            <div style={{ fontSize: 12.5, color: palette.textSecondary }}>{t('reports.v2.reopenTitle')}</div>
            <div style={{ fontSize: 21, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {s?.quality.reopenedAll ?? '…'}{' '}
              {s && s.total > 0 && (
                <span style={{ fontSize: 13, fontWeight: 600, color: palette.textSecondary }}>
                  ({reopenPct.toFixed(1).replace('.', lang === 'vi' ? ',' : '.')}%)
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: reopenPct > 5 ? C.overdue : palette.textSecondary, marginTop: 2 }}>
              {reopenPct > 5 ? t('reports.v2.reopenWarn') : t('reports.v2.reopenOk')}
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card>
            <div style={{ fontSize: 12.5, color: palette.textSecondary }}>{t('reports.v2.junkTitle')}</div>
            <div style={{ fontSize: 21, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {s?.quality.junk ?? '…'}
            </div>
            <div style={{ fontSize: 12, color: palette.textSecondary, marginTop: 2 }}>{t('reports.v2.junkNote')}</div>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card>
            <div style={{ fontSize: 12.5, color: palette.textSecondary }}>{t('reports.v2.lateTitle')}</div>
            <div style={{ fontSize: 21, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {s?.quality.snoozeDue ?? '…'}
            </div>
            <div style={{ fontSize: 12, color: palette.textSecondary, marginTop: 2 }}>{t('reports.v2.lateNote')}</div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}

const legendDot = (bg: string): React.CSSProperties => ({
  display: 'inline-block',
  width: 10,
  height: 10,
  borderRadius: 3,
  background: bg,
  marginRight: 6,
});

type TF = ReturnType<typeof useTranslation>['t'];

function timeColumns(t: TF, granularity: ReportGranularity): ColumnsType<TimeBucket> {
  return [
    { title: t(`reports.granularity.${granularity}`), dataIndex: 'bucket' },
    { title: t('reports.metric.created'), dataIndex: 'created' },
    { title: t('reports.metric.handled'), dataIndex: 'handled' },
    { title: t('reports.metric.closed'), dataIndex: 'closed' },
    { title: t('reports.metric.open'), dataIndex: 'open' },
    { title: t('reports.metric.overdue'), dataIndex: 'overdue' },
    { title: t('reports.metric.reopened'), dataIndex: 'reopened' },
  ];
}

function staffColumns(t: TF, fmtDays: (d: number | null | undefined) => string): ColumnsType<StaffRow> {
  return [
    {
      title: t('ticket.assignee'),
      render: (_, r) =>
        r.assigneeId === null ? (
          <Typography.Text type="secondary">{t('reports.v2.poolRow')}</Typography.Text>
        ) : (
          (r.name ?? '—')
        ),
      width: 200,
    },
    { title: t('reports.v2.holding'), dataIndex: 'holding', align: 'right', width: 90 },
    {
      title: t('reports.metric.handled'),
      dataIndex: 'handled',
      align: 'right',
      width: 100,
      render: (v: number, r) => (r.assigneeId === null ? '—' : <b>{v}</b>),
    },
    {
      title: t('reports.metric.overdue'),
      dataIndex: 'overdue',
      align: 'right',
      width: 90,
      render: (v: number) => <Tag color={v > 0 ? 'red' : undefined}>{v}</Tag>,
    },
    {
      title: t('reports.v2.avgCol'),
      align: 'right',
      width: 120,
      render: (_, r) => (r.assigneeId === null ? '—' : fmtDays(r.avgDays)),
    },
    {
      title: t('reports.v2.onTime'),
      width: 170,
      render: (_, r) => {
        if (r.assigneeId === null || r.onTimePct === null) return '—';
        const v = Math.round(r.onTimePct);
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, height: 6, borderRadius: 999, background: '#EEF1F6', overflow: 'hidden' }}>
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${v}%`,
                  borderRadius: 999,
                  background: v >= 80 ? C.handled : v >= 50 ? C.status.pending : C.overdue,
                }}
              />
            </span>
            <b style={{ width: 38, textAlign: 'right', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{v}%</b>
          </span>
        );
      },
    },
  ];
}
