import { Tag, Typography } from 'antd';

/**
 * Category (= company / danh mục) chip. Categories carry no colour in the data model
 * (only tags do), so a plain name rendered next to coloured status/tag chips looked
 * unstyled. This gives every category a STABLE colour derived from its name — same
 * company → same chip every time — from a muted, brand-safe palette that stays
 * "quiet enterprise" (soft tint + readable ink, not neon). No backend change.
 *
 * Colour is keyed on the Vietnamese name so it stays identical across VI/EN display.
 */
type CategoryRef = { vi: string; en: string } | null | undefined;

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
  const c = CHIPS[hash(category.vi || category.en) % CHIPS.length]!;
  return (
    <Tag
      style={{
        margin: 0,
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.fg}2E`, // ~18% ink border — soft edge
        fontWeight: 500,
        ...style,
      }}
    >
      {category[lang]}
    </Tag>
  );
}
