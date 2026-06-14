import { Tag, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { isAwayNow } from '../lib/tickets';

function vnDate(iso: string): string {
  // iso is a plain 'YYYY-MM-DD'; render as dd/mm.
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

/** "Vắng mặt đến dd/mm" chip shown next to an assignee while their window is active. */
export function AwayBadge({ awayFrom, awayTo }: { awayFrom: string | null; awayTo: string | null }) {
  const { t } = useTranslation();
  if (!isAwayNow(awayFrom, awayTo)) return null;
  const label = awayTo ? t('availability.awayUntil', { date: vnDate(awayTo) }) : t('availability.away');
  return (
    <Tooltip title={label}>
      <Tag color="orange" style={{ marginInlineStart: 4 }}>
        {label}
      </Tag>
    </Tooltip>
  );
}
