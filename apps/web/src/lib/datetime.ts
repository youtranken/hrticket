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
