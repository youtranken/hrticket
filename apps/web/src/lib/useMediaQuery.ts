import { useEffect, useState } from 'react';

/** Reactive CSS media-query match (SSR/jsdom-safe: no matchMedia → false). */
export function useMediaQuery(query: string): boolean {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [match, setMatch] = useState(() => (supported ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (!supported) return;
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent) => setMatch(e.matches);
    mq.addEventListener('change', on);
    setMatch(mq.matches);
    return () => mq.removeEventListener('change', on);
  }, [query, supported]);
  return match;
}

/** Phone-width viewport (the desktop 64px icon rail is intentional — only narrow
 *  screens switch to the Drawer navigation, per the owner's direction). */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)');
}
