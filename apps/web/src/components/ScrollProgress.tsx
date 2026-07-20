import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from 'antd';
import { UpOutlined } from '@ant-design/icons';
import { palette } from '../theme';

/**
 * Back-to-top button that doubles as a scroll-progress meter: a circular FAB whose
 * ring fills 0→100% with scroll depth, showing an up-arrow + the % in the centre; a
 * slim bar at the very top mirrors the same progress. Click scrolls to the top.
 *
 * The app is window-scrolled (AppShell has no inner overflow container), so we measure
 * `document.documentElement`. The FAB appears once you've scrolled a little (like the
 * old BackTop). Replaces FloatButton.BackTop. The '%' readout needs no i18n (number).
 */
export function ScrollProgress() {
  const { t } = useTranslation();
  const [pct, setPct] = useState(0);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const compute = () => {
      const el = document.documentElement;
      const max = el.scrollHeight - el.clientHeight;
      setPct(max > 0 ? Math.min(100, Math.max(0, Math.round((el.scrollTop / max) * 100))) : 0);
      setShow(max > 4 && el.scrollTop > 120); // appear once scrolled a bit
    };
    compute();
    window.addEventListener('scroll', compute, { passive: true });
    window.addEventListener('resize', compute);
    // The thread renders after data loads, so the page can grow — re-measure a beat later.
    const id = window.setTimeout(compute, 300);
    return () => {
      window.removeEventListener('scroll', compute);
      window.removeEventListener('resize', compute);
      window.clearTimeout(id);
    };
  }, []);

  return (
    <>
      {/* Slim bar pinned to the very top, filling left→right with scroll depth. */}
      <div style={{ position: 'fixed', top: 0, insetInline: 0, height: 3, zIndex: 1001, pointerEvents: 'none' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: palette.primary, transition: 'width 80ms linear' }} />
      </div>

      {show && (
        <Tooltip title={t('common.backToTop')} placement="left">
          <button
            aria-label={t('common.backToTop')}
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            style={{
              position: 'fixed',
              insetInlineEnd: 28,
              insetBlockEnd: 28,
              zIndex: 1001,
              width: 48,
              height: 48,
              borderRadius: '50%',
              border: 'none',
              cursor: 'pointer',
              padding: 3,
              // The ring itself IS the progress meter (conic fill by percentage).
              background: `conic-gradient(${palette.primary} ${pct * 3.6}deg, ${palette.primary}22 0deg)`,
              boxShadow: '0 3px 12px rgba(0,0,0,.22)',
              transition: 'background 80ms linear',
            }}
          >
            <span
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1,
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                background: '#fff',
                color: palette.primary,
                lineHeight: 1,
              }}
            >
              <UpOutlined style={{ fontSize: 11 }} />
              <span style={{ fontSize: 10, fontWeight: 700 }}>{pct}%</span>
            </span>
          </button>
        </Tooltip>
      )}
    </>
  );
}
