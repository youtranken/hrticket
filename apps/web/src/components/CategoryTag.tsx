import { Tag, Typography } from 'antd';

/**
 * Category (= company / danh mục) chip. Colour is INTENTIONAL, not automatic: an admin
 * picks a colour per category and only then does the chip carry that hue (soft tint —
 * "quiet enterprise"). A category with no colour chosen renders as a NEUTRAL slate chip
 * — still a proper chip (not a bare, broken-looking span), just visually quiet so the
 * admin-coloured ones stand out as deliberate highlights.
 */
type CategoryRef = { vi: string; en: string; color?: string | null } | null | undefined;

// The quiet, colour-less default: a slate chip in the navy text family.
const NEUTRAL = { fg: '#5A6478', bg: '#F1F3F7', border: '#E2E6EE' } as const;

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
  // Admin-chosen colour → soft tint of that hue; otherwise the neutral slate chip.
  const chip = category.color
    ? {
        fg: category.color,
        bg: `color-mix(in srgb, ${category.color} 13%, #fff)`,
        border: `color-mix(in srgb, ${category.color} 32%, #fff)`,
      }
    : NEUTRAL;
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
