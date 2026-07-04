import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AutoComplete, Input, Tag, Typography } from 'antd';
import type { InputRef } from 'antd';
import { useTicketSearch, displayCode, type SearchResultItem } from '../../lib/tickets';
import { useMe } from '../../lib/auth';
import { renderHeadline } from './headline';

const { Text } = Typography;
const RECENT_KEY = 'ticket-search-recent';
const MAX_RECENT = 5;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}
function pushRecent(q: string): void {
  const trimmed = q.trim();
  if (!trimmed) return;
  const next = [trimmed, ...loadRecent().filter((r) => r !== trimmed)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Tiny debounce so each keystroke doesn't fire a query. */
function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Global ticket search in the header (Story 10.2, FR81). Ctrl+K focuses it; typing
 * shows a quick dropdown of the top 5 hits with the matched snippet highlighted;
 * Enter opens the full results page. Recent queries persist in localStorage.
 */
export function GlobalSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: me } = useMe();
  const ssa = me?.role === 'ssa';
  const inputRef = useRef<InputRef>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);

  // The search box lives in the persistent header → clear it on every navigation so a
  // stale query (or a ticket id from a picked result) never lingers across pages.
  useEffect(() => {
    setText('');
    setOpen(false);
  }, [location.pathname]);
  const debounced = useDebounced(text, 250);
  const { data } = useTicketSearch(debounced, 1, 5, open);

  // Ctrl/Cmd+K focuses the search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const goResults = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    pushRecent(trimmed);
    setOpen(false);
    setText(''); // clear the box once the search is submitted (results live on /search)
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  const options = useMemo(() => {
    if (!debounced.trim()) {
      // Empty box → recent queries (value prefixed so onSelect can tell them apart).
      return loadRecent().map((r) => ({
        value: `recent:${r}`,
        label: (
          <Text type="secondary">
            {t('reports.search.recent')}: {r}
          </Text>
        ),
      }));
    }
    const items = data?.items ?? [];
    return items.map((it: SearchResultItem) => ({
      value: it.id,
      label: <ResultRow item={it} ssa={ssa} />,
    }));
  }, [debounced, data, ssa, t]);

  return (
    <AutoComplete
      style={{ minWidth: 280 }}
      open={open}
      options={options}
      // The displayed value is controlled on the AutoComplete itself, NOT on the inner
      // Input — AntD clones the child and would otherwise OVERRIDE the Input's `value`
      // with the picked option's value (the ticket id), leaving "158xxx" stuck in the box.
      value={text}
      onChange={(v: string) => {
        // Selecting a recent option also fires onChange with its `recent:` value — ignore
        // that (onSelect handles it). Keep only genuine typing. A ticket pick navigates +
        // the route-change effect clears the box, so any momentary id never lingers.
        if (v?.startsWith('recent:')) return;
        setText(v);
        setOpen(true);
      }}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onSelect={(value: string) => {
        if (value.startsWith('recent:')) {
          const r = value.slice('recent:'.length);
          setText(r);
          goResults(r);
        } else {
          // Selected a ticket result → open it directly; clear the box immediately.
          setText('');
          setOpen(false);
          navigate(`/tickets/${value}`);
        }
      }}
    >
      <Input.Search
        ref={inputRef}
        allowClear
        aria-label={t('reports.search.placeholder')}
        placeholder={t('reports.search.placeholder')}
        onSearch={goResults}
      />
    </AutoComplete>
  );
}

/** One dropdown row: code badge + subject + highlighted snippet + match label. */
function ResultRow({ item, ssa }: { item: SearchResultItem; ssa: boolean }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>{displayCode(item.ticketCode, item.projectKey, ssa)}</strong>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.subject}
        </span>
        <Tag color="default">{t(`reports.search.match.${item.matchType}`)}</Tag>
      </div>
      {item.headline && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {renderHeadline(item.headline)}
        </Text>
      )}
    </div>
  );
}
