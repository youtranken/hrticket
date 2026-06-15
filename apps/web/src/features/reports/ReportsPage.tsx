import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Col, Row, Segmented, Statistic, Table, Typography, Space, Empty } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { EChart } from './EChart';
import { ExportButton } from './ExportButton';
import { exportReport } from '../../lib/export';
import {
  useReportByTime,
  useReportByCategory,
  useReportByStaff,
  type ReportRange,
  type CategoryRow,
  type StaffRow,
  type TimeBucket,
} from '../../lib/reports';
import i18n from '../../i18n';

type Preset = 'month' | 'quarter' | 'year' | 'all';

/** VN 'YYYY-MM-DD' for `d`. */
function vnDay(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

/** Translate a preset into a VN-day range. */
function rangeFor(preset: Preset): ReportRange {
  const now = new Date();
  const y = now.getFullYear();
  if (preset === 'all') return {};
  if (preset === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (preset === 'quarter') {
    const q = Math.floor(now.getMonth() / 3);
    const startMonth = q * 3;
    return { from: vnDay(new Date(y, startMonth, 1)), to: vnDay(new Date(y, startMonth + 3, 0)) };
  }
  // month
  return { from: vnDay(new Date(y, now.getMonth(), 1)), to: vnDay(new Date(y, now.getMonth() + 1, 0)) };
}

/** Report dashboard (Story 10.3, FR83): overview cards + 3 charts, each with a
 *  number table; click a category bar drills into the Inbox filter (10.1). */
export function ReportsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [preset, setPreset] = useState<Preset>('year');
  const range = useMemo(() => rangeFor(preset), [preset]);
  const lang = i18n.language === 'en' ? 'en' : 'vi';

  const time = useReportByTime(range);
  const category = useReportByCategory(range);
  const staff = useReportByStaff(range);

  const buckets = time.data?.buckets ?? [];
  const cats = category.data?.categories ?? [];
  const staffRows = staff.data?.staff ?? [];

  // Overview totals (sum across buckets).
  const totals = buckets.reduce(
    (acc, b) => ({
      open: acc.open + b.open,
      closed: acc.closed + b.closed,
      overdue: acc.overdue + b.overdue,
      reopened: acc.reopened + b.reopened,
    }),
    { open: 0, closed: 0, overdue: 0, reopened: 0 },
  );

  const catLabel = (c: CategoryRow) =>
    c.categoryId === null ? t('reports.dashboard.uncategorized') : (lang === 'en' ? c.nameEn : c.nameVi) ?? '—';

  return (
    <div>
      <Space align="center" style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t('reports.dashboard.title')}
        </Typography.Title>
        <Segmented<Preset>
          value={preset}
          onChange={(v) => setPreset(v)}
          options={[
            { label: t('reports.dashboard.presetMonth'), value: 'month' },
            { label: t('reports.dashboard.presetQuarter'), value: 'quarter' },
            { label: t('reports.dashboard.presetYear'), value: 'year' },
            { label: t('reports.dashboard.presetAll'), value: 'all' },
          ]}
        />
      </Space>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card><Statistic title={t('reports.metric.open')} value={totals.open} /></Card></Col>
        <Col span={6}><Card><Statistic title={t('reports.metric.closed')} value={totals.closed} /></Card></Col>
        <Col span={6}><Card><Statistic title={t('reports.metric.overdue')} value={totals.overdue} valueStyle={{ color: '#cf1322' }} /></Card></Col>
        <Col span={6}><Card><Statistic title={t('reports.metric.reopened')} value={totals.reopened} /></Card></Col>
      </Row>

      {/* By time — line chart + table. */}
      <Card
        title={t('reports.dashboard.byTime')}
        extra={<ExportButton onExport={(f) => exportReport('by-time', range, f)} />}
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
                legend: { data: [t('reports.metric.created'), t('reports.metric.closed'), t('reports.metric.overdue')] },
                xAxis: { type: 'category', data: buckets.map((b) => b.bucket) },
                yAxis: { type: 'value' },
                series: [
                  { name: t('reports.metric.created'), type: 'line', data: buckets.map((b) => b.created) },
                  { name: t('reports.metric.closed'), type: 'line', data: buckets.map((b) => b.closed) },
                  { name: t('reports.metric.overdue'), type: 'line', data: buckets.map((b) => b.overdue) },
                ],
              }}
            />
            <Table<TimeBucket>
              rowKey="bucket"
              size="small"
              pagination={false}
              dataSource={buckets}
              columns={timeColumns(t)}
              style={{ marginTop: 12 }}
            />
          </>
        )}
      </Card>

      {/* By category — bar chart (click → drill) + table. */}
      <Card
        title={t('reports.dashboard.byCategory')}
        extra={<ExportButton onExport={(f) => exportReport('by-category', range, f)} />}
        style={{ marginBottom: 16 }}
        loading={category.isLoading}
      >
        {cats.length === 0 ? (
          <Empty description={t('reports.dashboard.noData')} />
        ) : (
          <>
            <EChart
              option={{
                tooltip: { trigger: 'axis' },
                xAxis: { type: 'category', data: cats.map(catLabel) },
                yAxis: { type: 'value' },
                series: [{ name: t('reports.metric.created'), type: 'bar', data: cats.map((c) => c.created) }],
              }}
              onClick={({ dataIndex }) => {
                const c = cats[dataIndex];
                if (!c || c.categoryId === null) return;
                const p = new URLSearchParams();
                p.set('categoryId', String(c.categoryId));
                if (range.from) p.set('createdFrom', range.from);
                if (range.to) p.set('createdTo', range.to);
                navigate(`/inbox?${p.toString()}`);
              }}
            />
            <Table<CategoryRow>
              rowKey={(r) => String(r.categoryId)}
              size="small"
              pagination={false}
              dataSource={cats}
              columns={categoryColumns(t, catLabel)}
              style={{ marginTop: 12 }}
            />
          </>
        )}
      </Card>

      {/* By staff — horizontal bar + table. */}
      <Card
        title={t('reports.dashboard.byStaff')}
        extra={<ExportButton onExport={(f) => exportReport('by-staff', range, f)} />}
        loading={staff.isLoading}
      >
        {staffRows.length === 0 ? (
          <Empty description={t('reports.dashboard.noData')} />
        ) : (
          <>
            <EChart
              height={Math.max(240, staffRows.length * 36)}
              option={{
                tooltip: { trigger: 'axis' },
                grid: { left: 120 },
                xAxis: { type: 'value' },
                yAxis: {
                  type: 'category',
                  data: staffRows.map((s) => s.name ?? t('reports.dashboard.unassigned')),
                },
                series: [{ name: t('reports.metric.handled'), type: 'bar', data: staffRows.map((s) => s.handled) }],
              }}
            />
            <Table<StaffRow>
              rowKey={(r) => r.assigneeId ?? 'pool'}
              size="small"
              pagination={false}
              dataSource={staffRows}
              columns={staffColumns(t)}
              style={{ marginTop: 12 }}
            />
          </>
        )}
      </Card>
    </div>
  );
}

type TF = ReturnType<typeof useTranslation>['t'];

function timeColumns(t: TF): ColumnsType<TimeBucket> {
  return [
    { title: t('reports.dashboard.month'), dataIndex: 'bucket' },
    { title: t('reports.metric.created'), dataIndex: 'created' },
    { title: t('reports.metric.closed'), dataIndex: 'closed' },
    { title: t('reports.metric.open'), dataIndex: 'open' },
    { title: t('reports.metric.overdue'), dataIndex: 'overdue' },
    { title: t('reports.metric.reopened'), dataIndex: 'reopened' },
  ];
}
function categoryColumns(t: TF, label: (c: CategoryRow) => string): ColumnsType<CategoryRow> {
  return [
    { title: t('ticket.category'), render: (_, r) => label(r) },
    { title: t('reports.metric.created'), dataIndex: 'created' },
    { title: t('reports.metric.closed'), dataIndex: 'closed' },
    { title: t('reports.metric.open'), dataIndex: 'open' },
    { title: t('reports.metric.overdue'), dataIndex: 'overdue' },
  ];
}
function staffColumns(t: TF): ColumnsType<StaffRow> {
  return [
    { title: t('ticket.assignee'), render: (_, r) => r.name ?? t('reports.dashboard.unassigned') },
    { title: t('reports.metric.handled'), dataIndex: 'handled' },
    { title: t('reports.metric.closed'), dataIndex: 'closed' },
    { title: t('reports.metric.open'), dataIndex: 'open' },
    { title: t('reports.metric.overdue'), dataIndex: 'overdue' },
  ];
}
