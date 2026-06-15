import type { ReactNode } from 'react';

/**
 * Render a `ts_headline` snippet (Story 10.2) safely. The server wraps matched
 * terms in `<b>…</b>`; the surrounding text is a user-supplied ticket subject, so
 * we DON'T inject it as HTML — we split on the known delimiters and build React
 * nodes, neutralising any other markup in the subject.
 */
export function renderHeadline(headline: string): ReactNode[] {
  const parts = headline.split(/(<b>|<\/b>)/);
  const out: ReactNode[] = [];
  let bold = false;
  let key = 0;
  for (const p of parts) {
    if (p === '<b>') {
      bold = true;
      continue;
    }
    if (p === '</b>') {
      bold = false;
      continue;
    }
    if (p === '') continue;
    out.push(bold ? <mark key={key++}>{p}</mark> : <span key={key++}>{p}</span>);
  }
  return out;
}
