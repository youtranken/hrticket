import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Typography } from 'antd';

const { Paragraph, Text } = Typography;

/** Boundary markers for a quoted reply chain (collapsed behind "•••"). */
const HTML_QUOTE = /<blockquote|class="gmail_quote"|class='gmail_quote'/i;
const TEXT_QUOTE = /^(>|-----\s*Original Message|On .+wrote:\s*$|________________)/m;

interface Props {
  html: string | null;
  text: string | null;
}

/**
 * Render an email body safely (Story 3.7). The HTML was sanitized SERVER-side
 * (the real XSS defence); here we only (a) keep remote images blocked until the
 * user opts in — `data-remote-src` re-armed to `src` (AC4), and (b) collapse the
 * quoted chain behind a toggle (AC3). Inline `cid:` images already point at signed
 * /api/files URLs and load same-origin with the session cookie.
 */
export function SafeMessageBody({ html, text }: Props) {
  const { t } = useTranslation();
  const [showRemote, setShowRemote] = useState(false);
  const [showQuote, setShowQuote] = useState(false);

  const hasRemote = !!html && html.includes('data-remote-src');

  const { main, quote } = useMemo(() => {
    if (html) {
      const armed = showRemote ? html.replace(/data-remote-src=/g, 'src=') : html;
      const m = HTML_QUOTE.exec(armed);
      return m ? { main: armed.slice(0, m.index), quote: armed.slice(m.index) } : { main: armed, quote: '' };
    }
    return { main: '', quote: '' };
  }, [html, showRemote]);

  if (html) {
    return (
      <div>
        <div className="email-body" dangerouslySetInnerHTML={{ __html: main }} />
        {quote && (
          <>
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setShowQuote((v) => !v)}>
              {showQuote ? t('render.hideQuote') : t('render.showQuote')}
            </Button>
            {showQuote && <div className="email-body email-quote" dangerouslySetInnerHTML={{ __html: quote }} />}
          </>
        )}
        {hasRemote && !showRemote && (
          <div style={{ marginTop: 8 }}>
            <Button size="small" onClick={() => setShowRemote(true)}>
              {t('render.showImages')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  // Plain-text fallback (no HTML part) — collapse a quoted tail too.
  if (!text) return <Text type="secondary">({t('ticket.emptyBody')})</Text>;
  const qm = TEXT_QUOTE.exec(text);
  const mainText = qm ? text.slice(0, qm.index) : text;
  const quoteText = qm ? text.slice(qm.index) : '';
  return (
    <div>
      <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{mainText.trimEnd()}</Paragraph>
      {quoteText && (
        <>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setShowQuote((v) => !v)}>
            {showQuote ? t('render.hideQuote') : t('render.showQuote')}
          </Button>
          {showQuote && (
            <Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {quoteText}
            </Paragraph>
          )}
        </>
      )}
    </div>
  );
}
