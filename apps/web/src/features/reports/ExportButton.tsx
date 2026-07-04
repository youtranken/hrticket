import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dropdown, Button, App as AntApp } from 'antd';
import type { ExportFormat } from '../../lib/export';

/**
 * "Export ▾ (Excel/CSV)" button (Story 10.4). The caller supplies the actual
 * export call (already bound to the current filters/range); this just renders the
 * format menu, shows a spinner while the file builds, and toasts errors (e.g. the
 * >10k EXPORT_TOO_LARGE 422).
 */
export function ExportButton({ onExport }: { onExport: (format: ExportFormat) => Promise<void> }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);

  const run = async (format: ExportFormat) => {
    setBusy(true);
    try {
      await onExport(format);
    } catch (e) {
      // The BE's over-cap 422 carries an i18n KEY as its message — translate it
      // instead of toasting the raw "reports.export.tooLarge".
      const raw = (e as Error).message;
      message.error(
        raw === 'reports.export.tooLarge' ? t('reports.export.tooLarge') : raw || t('reports.export.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dropdown
      menu={{
        items: [
          { key: 'xlsx', label: t('reports.export.excel'), onClick: () => run('xlsx') },
          { key: 'csv', label: t('reports.export.csv'), onClick: () => run('csv') },
        ],
      }}
    >
      <Button loading={busy}>{t('reports.export.button')}</Button>
    </Dropdown>
  );
}
