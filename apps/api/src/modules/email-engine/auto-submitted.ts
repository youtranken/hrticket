/**
 * Detect machine-generated mail (out-of-office, bounces, list traffic) so the
 * intake never reacts to it — no auto-ack, no reopen, no new ticket from a loop
 * (FR11 / NFR11). Conservative: any of the well-known signals flips it on.
 */
export function isAutoSubmitted(headers: Map<string, string>): boolean {
  const get = (k: string) => (headers.get(k) ?? '').toLowerCase().trim();

  // RFC 3834: anything other than "no" means auto-generated/replied.
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;

  const precedence = get('precedence');
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return true;

  if (get('x-autoreply')) return true;
  if (get('x-autorespond')) return true;
  if (get('x-autoreply-from')) return true;
  if (headers.has('list-id') || headers.has('list-unsubscribe')) return true;

  return false;
}
