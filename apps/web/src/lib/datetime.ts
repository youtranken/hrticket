import i18n from '../i18n';

/**
 * The ONE datetime formatter (#61). BE speaks ISO-8601 UTC (invariant #10); every
 * on-screen date renders in VN time regardless of the browser's zone, and the
 * locale follows the active UI language (en-GB keeps the dd/mm order VN users read).
 */
const TZ = 'Asia/Ho_Chi_Minh';
const locale = (): string => (i18n.language === 'en' ? 'en-GB' : 'vi-VN');

export function fmtDateTime(iso: string | number | Date | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(locale(), { timeZone: TZ, hour12: false });
}

export function fmtDate(iso: string | number | Date | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(locale(), { timeZone: TZ });
}

export function fmtTime(iso: string | number | Date | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(locale(), { timeZone: TZ, hour12: false });
}

/** Today's VN calendar date as YYYY-MM-DD (for native <input type="date"> bounds). */
export function todayVn(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

/**
 * "2 giờ trước" / "2 hours ago" — scannable relative time; pair it with `fmtDateTime`
 * in a tooltip for the exact stamp. Lang defaults to the active UI language, so the
 * ticket list and the notification bell now read the same way (they used to diverge:
 * list = relative, bell = absolute). Buckets minute → hour → day → month.
 */
export function fmtRelative(
  iso: string | number | Date | null | undefined,
  lang?: 'vi' | 'en',
): string {
  if (!iso) return '';
  const l = lang ?? (i18n.language === 'en' ? 'en' : 'vi');
  const diffMs = Date.now() - new Date(iso).getTime();
  const rtf = new Intl.RelativeTimeFormat(l, { numeric: 'auto' });
  const min = Math.round(diffMs / 60000);
  if (Math.abs(min) < 60) return rtf.format(-min, 'minute');
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return rtf.format(-hr, 'hour');
  const day = Math.round(hr / 24);
  if (Math.abs(day) < 30) return rtf.format(-day, 'day');
  return rtf.format(-Math.round(day / 30), 'month');
}
