/**
 * Global motion vocabulary — ONE rhythm for the whole app so every animation shares
 * the same duration/easing feel (ui-ux-pro-max §7: 150–300ms micro-interactions,
 * ease-out entering / ease-in exiting, transform+opacity only). These constants are
 * mirrored as CSS variables in index.css (:root) — keep the two in sync. All motion is
 * disabled under `prefers-reduced-motion` (global guard in index.css).
 */
export const motion = {
  // Durations (ms)
  fast: 150, // hover / press feedback
  base: 220, // route + element enter
  slow: 320, // larger surfaces

  // Easing curves
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)', // entering — smooth with a slight settle
  easeIn: 'cubic-bezier(0.4, 0, 1, 1)', // exiting — a touch quicker than enter

  // List / grid reveal step per item
  stagger: 40,
} as const;
