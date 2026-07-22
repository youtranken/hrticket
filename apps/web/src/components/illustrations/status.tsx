/**
 * Branded status illustrations for 403 / 404 / app-error pages. Same navy + gold
 * line-art family as the empty states (see ./empty.tsx). aria-hidden — meaning is
 * carried by the adjacent title/description.
 */
import { palette } from '../../theme';

const NAVY = palette.primary;
const GOLD = palette.brandGold;
const TINT = '#EAF0F8';
const LINE = '#C7D2E4';

type ArtProps = { size?: number };

function frame(size: number) {
  return { width: size, height: (size * 120) / 160, viewBox: '0 0 160 120' } as const;
}

/** 403 — a shield with a lock: you don't have access. */
export function ForbiddenArt({ size = 168 }: ArtProps) {
  return (
    <svg {...frame(size)} fill="none" aria-hidden="true">
      <ellipse cx="80" cy="106" rx="50" ry="7" fill={TINT} />
      <path
        d="M80 20l34 12v26c0 24-16 38-34 44-18-6-34-20-34-44V32l34-12Z"
        fill="#F7FAFF"
        stroke={NAVY}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <rect x="64" y="56" width="32" height="26" rx="5" fill={TINT} stroke={NAVY} strokeWidth="2.5" />
      <path d="M69 56v-6a11 11 0 0 1 22 0v6" stroke={NAVY} strokeWidth="2.5" />
      <circle cx="80" cy="67" r="4" fill={GOLD} />
      <path d="M80 71v6" stroke={GOLD} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** 404 — a compass with the needle off-course: page not found. */
export function NotFoundArt({ size = 168 }: ArtProps) {
  return (
    <svg {...frame(size)} fill="none" aria-hidden="true">
      <ellipse cx="80" cy="106" rx="50" ry="7" fill={TINT} />
      <circle cx="80" cy="58" r="40" fill="#F7FAFF" stroke={NAVY} strokeWidth="2.5" />
      <circle cx="80" cy="58" r="30" fill="none" stroke={LINE} strokeWidth="2" strokeDasharray="2 6" />
      <path d="M80 58 96 42l-8 24-24 8 16-16Z" fill={GOLD} stroke={NAVY} strokeWidth="2" strokeLinejoin="round" />
      <circle cx="80" cy="58" r="4" fill={NAVY} />
      <path d="M80 18v6M80 92v6M40 58h6M114 58h6" stroke={NAVY} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** App error — an unplugged / warning card: something broke, try again. */
export function ServerErrorArt({ size = 168 }: ArtProps) {
  return (
    <svg {...frame(size)} fill="none" aria-hidden="true">
      <ellipse cx="80" cy="106" rx="50" ry="7" fill={TINT} />
      <rect x="34" y="30" width="92" height="60" rx="8" fill="#F7FAFF" stroke={NAVY} strokeWidth="2.5" />
      <path d="M34 46h92" stroke={NAVY} strokeWidth="2.5" />
      <circle cx="43" cy="38" r="2.4" fill={LINE} />
      <circle cx="51" cy="38" r="2.4" fill={LINE} />
      <path d="M80 56v14M80 78h.01" stroke={GOLD} strokeWidth="4" strokeLinecap="round" />
      <path
        d="M80 52l16 26H64l16-26Z"
        fill="none"
        stroke={NAVY}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
