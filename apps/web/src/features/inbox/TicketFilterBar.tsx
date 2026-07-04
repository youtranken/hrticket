import { useTranslation } from 'react-i18next';
import { Select, Input, Button, Space, Tag, Typography } from 'antd';
import { useMe } from '../../lib/auth';
import { useFilterOptions, type TicketFilters } from '../../lib/tickets';
import i18n from '../../i18n';

const { Text } = Typography;
const STATUSES = ['open', 'assigned', 'in_progress', 'pending', 'resolved', 'closed'] as const;

/**
 * Worklist filters (Story 10.1, FR79) — v2 layout: the fields live in a persistent
 * RIGHT COLUMN (hr-1 style) that the inbox shows beside the list and pushes the table
 * left, instead of an overlay popup. The toggle button + Export sit in the toolbar;
 * removable chips render above the list. State still lives in the URL (parent owns
 * value/onChange) so links stay shareable; options come RLS-scoped from
 * /tickets/filter-options. Dates use native inputs (the app avoids dayjs/DatePicker).
 */
export function TicketFilterPanel({
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
  const active = hasActiveFilters(value);

  const field = (label: string, control: React.ReactNode) => (
    <div>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
        {label}
      </Text>
      {control}
    </div>
  );

  return (
    <div
      style={{
        // Fixed side rail on desktop; a wrapped full-width block on narrow screens
        // (the parent flex row wraps — see TicketListView).
        flex: '1 0 300px',
        maxWidth: 360,
        alignSelf: 'stretch',
        // Full-height column even when the list is empty/short (so it reads as a fixed
        // side rail, not a floating box).
        minHeight: 'calc(100vh - 210px)',
        background: '#fff',
        border: '1px solid #EAEDF3',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text strong>{t('reports.filter.button')}</Text>
        {(active || !isWorklistOrder) && (
          <Button type="link" size="small" style={{ padding: 0 }} onClick={onReset}>
            {t('reports.filter.clear')}
          </Button>
        )}
      </div>
      {field(
        t('reports.filter.status'),
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          maxTagCount="responsive"
          value={value.status ?? []}
          onChange={(v: string[]) => set({ status: v.length ? v : undefined })}
          options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
        />,
      )}
      {field(
        t('reports.filter.category'),
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          maxTagCount="responsive"
          value={value.categoryId ?? []}
          onChange={(v: number[]) => set({ categoryId: v.length ? v : undefined })}
          options={(opts?.categories ?? []).map((c) => ({ value: c.id, label: lang === 'en' ? c.nameEn : c.nameVi }))}
        />,
      )}
      {field(
        t('reports.filter.tag'),
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          maxTagCount="responsive"
          value={value.tagId ?? []}
          onChange={(v: number[]) => set({ tagId: v.length ? v : undefined })}
          options={(opts?.tags ?? []).map((tg) => ({ value: tg.id, label: tg.name }))}
        />,
      )}
      {field(
        t('reports.filter.assignee'),
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          maxTagCount="responsive"
          value={value.assigneeId ?? []}
          onChange={(v: string[]) => set({ assigneeId: v.length ? v : undefined })}
          options={(opts?.assignees ?? []).map((a) => ({ value: a.id, label: a.name }))}
        />,
      )}
      {ssa &&
        field(
          t('reports.filter.project'),
          <Select
            allowClear
            style={{ width: '100%' }}
            value={value.projectId}
            onChange={(v?: number) => set({ projectId: v })}
            options={(me?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />,
        )}
      {field(
        t('reports.filter.createdFrom') + ' – ' + t('reports.filter.createdTo'),
        <Space size={4}>
          <Input
            type="date"
            aria-label={t('reports.filter.createdFrom')}
            style={{ width: 124 }}
            value={value.createdFrom ?? ''}
            max={value.createdTo || undefined}
            onChange={(e) => set({ createdFrom: e.target.value || undefined })}
          />
          <span>–</span>
          <Input
            type="date"
            aria-label={t('reports.filter.createdTo')}
            style={{ width: 124 }}
            value={value.createdTo ?? ''}
            min={value.createdFrom || undefined}
            onChange={(e) => set({ createdTo: e.target.value || undefined })}
          />
        </Space>,
      )}
    </div>
  );
}

/** Removable active-filter chips — shown above the list so applied filters stay visible
 *  even when the filter panel is closed. */
export function TicketFilterChips({
  value,
  onChange,
}: {
  value: TicketFilters;
  onChange: (next: TicketFilters) => void;
}) {
  const { t } = useTranslation();
  const { data: opts } = useFilterOptions();
  const lang = i18n.language === 'en' ? 'en' : 'vi';
  const set = (patch: Partial<TicketFilters>) => onChange({ ...value, ...patch });
  // P2: with 1–2 selections the chip shows the actual VALUES ("Trạng thái: Mở, Đã giao");
  // 3+ falls back to the count so the chip row can't overflow.
  const label = (title: string, names: string[]): string =>
    names.length <= 2 ? `${title}: ${names.join(', ')}` : `${title}: ${names.length}`;
  if (!hasActiveFilters(value)) return null;
  return (
    <Space wrap size={[8, 8]} style={{ marginBottom: 12 }}>
      {value.status?.length ? (
        <Tag closable onClose={() => set({ status: undefined })}>
          {label(t('reports.filter.status'), value.status.map((s) => t(`status.${s}`)))}
        </Tag>
      ) : null}
      {value.categoryId?.length ? (
        <Tag closable onClose={() => set({ categoryId: undefined })}>
          {label(
            t('reports.filter.category'),
            value.categoryId.map((id) => {
              const c = opts?.categories.find((x) => x.id === id);
              return c ? (lang === 'en' ? c.nameEn : c.nameVi) : String(id);
            }),
          )}
        </Tag>
      ) : null}
      {value.tagId?.length ? (
        <Tag closable onClose={() => set({ tagId: undefined })}>
          {label(
            t('reports.filter.tag'),
            value.tagId.map((id) => opts?.tags.find((x) => x.id === id)?.name ?? String(id)),
          )}
        </Tag>
      ) : null}
      {value.assigneeId?.length ? (
        <Tag closable onClose={() => set({ assigneeId: undefined })}>
          {label(
            t('reports.filter.assignee'),
            value.assigneeId.map((id) => opts?.assignees.find((x) => x.id === id)?.name ?? '…'),
          )}
        </Tag>
      ) : null}
      {value.projectId !== undefined ? (
        <Tag closable onClose={() => set({ projectId: undefined })}>
          {t('reports.filter.project')}
        </Tag>
      ) : null}
      {value.createdFrom || value.createdTo ? (
        <Tag closable onClose={() => set({ createdFrom: undefined, createdTo: undefined })}>
          {value.createdFrom ?? '…'} – {value.createdTo ?? '…'}
        </Tag>
      ) : null}
    </Space>
  );
}

/** Any filter applied? The view is a TAB (pinned on pool/mine, #24), not a filter. */
export function hasActiveFilters(f: TicketFilters): boolean {
  return Boolean(
    f.status?.length ||
      f.categoryId?.length ||
      f.tagId?.length ||
      f.assigneeId?.length ||
      f.projectId !== undefined ||
      f.createdFrom ||
      f.createdTo,
  );
}

/** Number of active filter groups (drives the toolbar badge). */
export function activeCount(f: TicketFilters): number {
  let n = 0;
  if (f.status?.length) n++;
  if (f.categoryId?.length) n++;
  if (f.tagId?.length) n++;
  if (f.assigneeId?.length) n++;
  if (f.projectId !== undefined) n++;
  if (f.createdFrom || f.createdTo) n++;
  return n;
}
