import { useTranslation } from 'react-i18next';
import { Select, Input, Button, Space, Segmented } from 'antd';
import { useMe } from '../../lib/auth';
import { useFilterOptions, type TicketFilters } from '../../lib/tickets';
import i18n from '../../i18n';

const STATUSES = ['open', 'assigned', 'in_progress', 'pending', 'resolved', 'closed'] as const;

/**
 * Filter bar for the worklist (Story 10.1, FR79). State lives in the URL (the
 * parent owns `value`/`onChange` against searchParams) so links are shareable.
 * Options come from the RLS-scoped `/tickets/filter-options` endpoint, so a user
 * can only ever filter by categories/assignees/tags they can already see.
 *
 * Date range uses native `<input type="date">` — the app deliberately avoids
 * dayjs / AntD DatePicker (same call as the snooze + availability inputs).
 */
export function TicketFilterBar({
  value,
  onChange,
  onReset,
  isWorklistOrder,
}: {
  value: TicketFilters;
  onChange: (next: TicketFilters) => void;
  onReset: () => void;
  isWorklistOrder: boolean;
}) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const { data: opts } = useFilterOptions();
  const lang = i18n.language === 'en' ? 'en' : 'vi';
  const ssa = me?.role === 'ssa';

  const set = (patch: Partial<TicketFilters>) => onChange({ ...value, ...patch });

  return (
    <Space wrap size={[8, 8]} style={{ marginBottom: 12, width: '100%' }}>
      <Segmented
        value={value.view ?? 'all'}
        onChange={(v) => set({ view: v as TicketFilters['view'] })}
        options={[
          { label: t('reports.filter.viewAll'), value: 'all' },
          { label: t('reports.filter.viewMine'), value: 'mine' },
          { label: t('reports.filter.viewPool'), value: 'pool' },
        ]}
      />
      <Select
        mode="multiple"
        allowClear
        placeholder={t('reports.filter.status')}
        style={{ minWidth: 180 }}
        maxTagCount="responsive"
        value={value.status ?? []}
        onChange={(v: string[]) => set({ status: v.length ? v : undefined })}
        options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
      />
      <Select
        mode="multiple"
        allowClear
        placeholder={t('reports.filter.category')}
        style={{ minWidth: 180 }}
        maxTagCount="responsive"
        value={value.categoryId ?? []}
        onChange={(v: number[]) => set({ categoryId: v.length ? v : undefined })}
        options={(opts?.categories ?? []).map((c) => ({ value: c.id, label: lang === 'en' ? c.nameEn : c.nameVi }))}
      />
      <Select
        mode="multiple"
        allowClear
        placeholder={t('reports.filter.tag')}
        style={{ minWidth: 160 }}
        maxTagCount="responsive"
        value={value.tagId ?? []}
        onChange={(v: number[]) => set({ tagId: v.length ? v : undefined })}
        options={(opts?.tags ?? []).map((tg) => ({ value: tg.id, label: tg.name }))}
      />
      <Select
        mode="multiple"
        allowClear
        placeholder={t('reports.filter.assignee')}
        style={{ minWidth: 180 }}
        maxTagCount="responsive"
        value={value.assigneeId ?? []}
        onChange={(v: string[]) => set({ assigneeId: v.length ? v : undefined })}
        options={(opts?.assignees ?? []).map((a) => ({ value: a.id, label: a.name }))}
      />
      {ssa && (
        <Select
          allowClear
          placeholder={t('reports.filter.project')}
          style={{ minWidth: 140 }}
          value={value.projectId}
          onChange={(v?: number) => set({ projectId: v })}
          options={(me?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
        />
      )}
      <Space size={4}>
        <Input
          type="date"
          aria-label={t('reports.filter.createdFrom')}
          style={{ width: 150 }}
          value={value.createdFrom ?? ''}
          onChange={(e) => set({ createdFrom: e.target.value || undefined })}
        />
        <span>–</span>
        <Input
          type="date"
          aria-label={t('reports.filter.createdTo')}
          style={{ width: 150 }}
          value={value.createdTo ?? ''}
          onChange={(e) => set({ createdTo: e.target.value || undefined })}
        />
      </Space>
      <Button onClick={onReset} disabled={isWorklistOrder && !hasActiveFilters(value)}>
        {t('reports.worklist.resetOrder')}
      </Button>
    </Space>
  );
}

/** Any filter or non-default ordering applied? Drives the reset button state. */
function hasActiveFilters(f: TicketFilters): boolean {
  return Boolean(
    f.status?.length ||
      f.categoryId?.length ||
      f.tagId?.length ||
      f.assigneeId?.length ||
      f.projectId !== undefined ||
      f.createdFrom ||
      f.createdTo ||
      (f.view && f.view !== 'all'),
  );
}
