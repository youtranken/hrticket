import { Tag, Typography } from 'antd';

/**
 * Category (= company / danh mục) chip. An admin can now pick a colour per category;
 * when set, the chip uses that hue as a soft tint (ink + light background, staying
 * "quiet enterprise"). When no colour is chosen, it falls back to a STABLE colour
 * derived from the name (same company → same chip) from a muted, brand-safe palette.
 *
 * Fallback colour is keyed on the Vietnamese name so it stays identical across VI/EN.
 */
type CategoryRef = { vi: string; en: string; color?: string | null } | null | undefined;

// Muted tint/ink pairs — each ink passes WCAG AA on its own soft tint.
const CHIPS: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: '#EAF0F8', fg: '#1F3A5F' }, // navy (brand)
  { bg: '#E7F5EE', fg: '#1B7A52' }, // green
  { bg: '#EEECF9', fg: '#574AA0' }, // plum
  { bg: '#E6F2F3', fg: '#0E6E74' }, // teal
  { bg: '#FBF0E4', fg: '#985B1C' }, // amber-brown
  { bg: '#FBEAEC', fg: '#A63347' }, // rose
  { bg: '#ECEFF3', fg: '#495468' }, // slate
  { bg: '#E9F0FB', fg: '#2B5AA8' }, // blue
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function CategoryTag({
  category,
  lang,
  style,
}: {
  category: CategoryRef;
  lang: 'vi' | 'en';
  style?: React.CSSProperties;
}) {
  if (!category) return <Typography.Text type="secondary">—</Typography.Text>;
  // Admin-chosen colour → soft tint of that hue; else a stable palette pick from the name.
  const chip = category.color
    ? {
        fg: category.color,
        bg: `color-mix(in srgb, ${category.color} 13%, #fff)`,
        border: `color-mix(in srgb, ${category.color} 32%, #fff)`,
      }
    : (() => {
        const c = CHIPS[hash(category.vi || category.en) % CHIPS.length]!;
        return { fg: c.fg, bg: c.bg, border: `${c.fg}2E` };
      })();
  return (
    <Tag
      style={{
        margin: 0,
        color: chip.fg,
        background: chip.bg,
        border: `1px solid ${chip.border}`,
        fontWeight: 500,
        ...style,
      }}
    >
      {category[lang]}
    </Tag>
  );
}
