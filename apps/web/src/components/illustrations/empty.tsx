/**
 * Branded empty-state illustrations — "quiet enterprise" line-art in the Phú Mỹ Hưng
 * navy + gold palette. Purely decorative (aria-hidden); the meaning lives in the
 * adjacent title/description text. Kept as inline SVG (no network, offline-safe,
 * recolours with the theme). One shared 160×120 viewBox so every state feels a family.
 */
import { palette } from '../../theme';

const NAVY = palette.primary; // #1F3A5F
const GOLD = palette.brandGold; // #E8B11C
const TINT = '#EAF0F8'; // soft navy wash (matches CategoryTag navy chip bg)
const LINE = '#C7D2E4'; // faint navy hairline

type ArtProps = { size?: number };

function frame(size: number) {
  return { width: size, height: (size * 120) / 160, viewBox: '0 0 160 120' } as const;
}

/** All-clear inbox: an empty tray with a gold "done" spark — the happy zero state. */
export function InboxZeroArt({ size = 160 }: ArtProps) {
  return (
    <svg {...frame(size)} fill="none" aria-hidden="true">
      <ellipse cx="80" cy="104" rx="52" ry="7" fill={TINT} />
      <path
        d="M40 46h80l10 30v22a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6V76l10-30Z"
        fill="#F7FAFF"
        stroke={NAVY}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M30 76h30l6 12h28l6-12h30" stroke={NAVY} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M56 34h48M62 22h36" stroke={LINE} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="118" cy="30" r="12" fill={GOLD} />
      <path
        d="m113 30 3.5 3.5L124 26"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** No data in range: a faint bar chart with a dotted baseline. For reports/dashboards. */
export function NoDataArt({ size = 160 }: ArtProps) {
  return (
    <svg {...frame(size)} fill="none" aria-hidden="true">
      <ellipse cx="80" cy="104" rx="52" ry="7" fill={TINT} />
      <rect x="34" y="30" width="92" height="66" rx="8" fill="#F7FAFF" stroke={NAVY} strokeWidth="2.5" />
      <path d="M46 84V66M64 84V54M82 84V72M100 84V60" stroke={LINE} strokeWidth="7" strokeLinecap="round" />
      <path d="M46 72V66M64 66V54M100 70V60" stroke={NAVY} strokeWidth="7" strokeLinecap="round" opacity="0.35" />
      <path d="M40 84h80" stroke={NAVY} strokeWidth="2.5" strokeLinecap="round" strokeDasharray="1 6" />
      <circle cx="112" cy="42" r="9" fill={GOLD} />
      <path d="M112 38v5M112 47h.01" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** No search results: a magnifier over an empty sheet. */
export function NoResultsArt({ size = 160 }: ArtProps) {
  return (
    <svg {...frame(size)} fill="none" aria-hidden="true">
      <ellipse cx="80" cy="104" rx="52" ry="7" fill={TINT} />
      <rect x="44" y="26" width="62" height="74" rx="8" fill="#F7FAFF" stroke={NAVY} strokeWidth="2.5" />
      <path d="M56 44h38M56 58h38M56 72h24" stroke={LINE} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="98" cy="76" r="20" fill="#fff" stroke={NAVY} strokeWidth="2.5" />
      <path d="m113 91 12 12" stroke={NAVY} strokeWidth="4" strokeLinecap="round" />
      <path d="M92 76h12" stroke={GOLD} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Empty bell (notifications dropdown) — smaller default size. */
export function NoNotificationsArt({ size = 96 }: ArtProps) {
  return (
    <svg {...frame(size)} fill="none" aria-hidden="true">
      <ellipse cx="80" cy="104" rx="40" ry="6" fill={TINT} />
      <path
        d="M80 26c-14 0-22 10-22 24 0 16-6 22-8 26h60c-2-4-8-10-8-26 0-14-8-24-22-24Z"
        fill="#F7FAFF"
        stroke={NAVY}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M72 88a8 8 0 0 0 16 0" stroke={NAVY} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M80 20v6" stroke={NAVY} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="102" cy="34" r="8" fill={GOLD} />
    </svg>
  );
}
