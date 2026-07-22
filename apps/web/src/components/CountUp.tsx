import { useEffect, useRef, useState } from 'react';
import { motion } from '../theme/motion';

/**
 * Animate a number from its previous value up to the target (ease-out cubic), rendering
 * through `format` so locale/grouping is preserved. Display-only — no layout impact.
 * Respects prefers-reduced-motion (jumps straight to the final value). While the value is
 * still loading (undefined) it renders `format(undefined)` unchanged (e.g. the "…" placeholder).
 */
export function CountUp({
  value,
  format,
  durationMs = 700,
}: {
  value: number | undefined;
  format: (v: number | undefined) => string;
  durationMs?: number;
}) {
  const [display, setDisplay] = useState(value ?? 0);
  const prev = useRef(value ?? 0);

  useEffect(() => {
    if (value == null) return;
    const reduce =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setDisplay(value);
      prev.current = value;
      return;
    }
    const from = prev.current;
    const to = value;
    if (from === to) {
      setDisplay(to);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  return <>{value == null ? format(undefined) : format(display)}</>;
}

// re-export so callers can tune with the shared vocabulary if needed
export { motion };
