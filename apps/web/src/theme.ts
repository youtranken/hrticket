import type { ThemeConfig } from 'antd';

/**
 * Design system (Story: v1 UI redesign) — "quiet enterprise": a calm, trustworthy,
 * data-forward look for an internal HR/C&B ticketing tool. Applied globally via
 * <ConfigProvider theme={appTheme}>. One place to tune the whole app's identity.
 *
 * Fonts (self-hosted via @fontsource — offline-safe, loaded in main.tsx):
 *   - Inter           → HEADINGS only (clean, neutral, news/dashboard) — applied in
 *                        index.css via --font-heading, not through the AntD token below.
 *   - System stack (Segoe UI…) → body / UI text: dense, renders identically VN & EN,
 *                        no web-font download.
 *   - JetBrains Mono  → ticket codes, IDs, monospaced data
 */

// ─── Brand & status palette (Phú Mỹ Hưng — Navy + Gold) ───────────────
// SINGLE SOURCE OF TRUTH for every colour in the app. Inline styles import
// `palette.*`; index.css mirrors these as CSS variables (:root) — keep the two in
// sync. Rule (from the team playbook §3): a value earns a token only when it repeats
// systematically; one-off decoration (login gradient stops, scrollbar greys) stays literal.
export const palette = {
  // Brand
  primary: '#1F3A5F', // deep navy — action color (buttons, links, selection): trust + premium
  brandGold: '#E8B11C', // Phú Mỹ Hưng logo gold — ACCENT only (highlights, active bar, premium touches)
  brandGoldSoft: '#FBF3DC',

  // Status (semantic)
  success: '#1F9D6B', // calm green
  warning: '#D97706', // amber-orange (overdue) — kept distinct from the brand gold
  error: '#D14343', // muted red
  info: '#3E63DD', // clear blue for info states — NOT the navy primary: Alert type="info"
  // derives its background/border from colorInfo, and the deep navy renders as a murky
  // dark tint. A lighter blue keeps info banners soft and readable.

  // Layout chrome
  siderBg: '#13243D', // near-black navy sidebar
  siderItemSelected: '#27407F',
  bodyBg: '#F5F6F8', // warm-neutral content canvas (matches the logo wordmark gray family)
  headerBg: '#FFFFFF',
  surface: '#FFFFFF', // cards / raised surfaces

  // Text (cool-slate in the navy family; contrast-checked on white)
  textSecondary: '#64748B', // ≈4.7:1 AA — Typography type="secondary", hints, meta
  textTertiary: '#8A94A6', // faint meta

  // Structure
  border: '#EAEDF3', // hairline separators / card & control borders
  fillSubtle: '#F7F8FB', // table header, grouped toolbar tray
  rowHover: '#F4F6FB', // table row hover

  // Accents & semantic tints (row backgrounds / soft banners)
  accentUnread: '#2F6BFF', // brighter blue — unread ticket accent bar (distinct from navy)
  errorSoft: '#FFF1F0', // overdue-row / danger banner background
  infoSoft: '#EEF4FF', // unclaimed-row / info banner background
  noteSoft: '#FFFBE6', // internal-note composer background
} as const;

// System font stack led by Segoe UI: full Vietnamese diacritics + clean Latin, renders
// identically for VN & EN, and needs NO web-font download (works offline / on-prem). Other
// OSes fall back to their native UI face, then Noto Sans for broad glyph coverage.
const fontStack =
  "'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, 'Roboto', 'Helvetica Neue', 'Noto Sans', Arial, sans-serif";
const monoStack = "'Cascadia Code', Consolas, 'SFMono-Regular', 'JetBrains Mono', monospace";

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: palette.primary, // navy; brand gold is applied per-component as an accent
    colorInfo: palette.info,
    colorSuccess: palette.success,
    colorWarning: palette.warning,
    colorError: palette.error,
    colorLink: palette.primary,

    fontFamily: fontStack,
    fontFamilyCode: monoStack,
    fontSize: 14, // dense-friendly base for power users
    fontSizeHeading1: 30,
    fontSizeHeading2: 24,
    fontSizeHeading3: 20,
    fontSizeHeading4: 16,
    fontSizeHeading5: 14,
    lineHeight: 1.5715,

    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,

    controlHeight: 36, // comfortable hit targets without bloat
    wireframe: false,

    // Muted text (Typography type="secondary", hints, meta). Cool-slate in the navy
    // family, dark enough to pass WCAG AA on white (#64748B ≈ 4.7:1 — the previous
    // #9BA4B5 was ~2.6:1 and unreadable for low-vision users).
    colorTextSecondary: palette.textSecondary,
    colorTextTertiary: palette.textTertiary,
    colorTextDescription: palette.textSecondary,

    colorBgLayout: palette.bodyBg,
    colorBorderSecondary: palette.border,
    boxShadowTertiary:
      '0 1px 2px rgba(15, 27, 51, 0.04), 0 4px 12px rgba(15, 27, 51, 0.06)',
  },

  components: {
    Layout: {
      siderBg: palette.siderBg,
      headerBg: palette.headerBg,
      bodyBg: palette.bodyBg,
      headerHeight: 56,
      headerPadding: '0 20px',
    },
    Menu: {
      // Dark sider menu — subtle indigo selection, rounded items, calm idle text.
      darkItemBg: palette.siderBg,
      darkSubMenuItemBg: palette.siderBg,
      darkItemSelectedBg: palette.siderItemSelected,
      darkItemSelectedColor: '#FFFFFF',
      darkItemColor: 'rgba(233, 238, 248, 0.72)',
      darkItemHoverBg: 'rgba(255, 255, 255, 0.06)',
      itemBorderRadius: 8,
      itemMarginInline: 8,
      itemHeight: 40,
      iconSize: 16,
    },
    Card: {
      borderRadiusLG: 12,
      boxShadowTertiary:
        '0 1px 2px rgba(15, 27, 51, 0.04), 0 4px 12px rgba(15, 27, 51, 0.06)',
      headerFontSize: 16,
    },
    Table: {
      headerBg: palette.fillSubtle,
      headerColor: '#5A6478', // one-off header ink (slightly darker than textSecondary)
      rowHoverBg: palette.rowHover,
      cellPaddingBlock: 12,
      headerSplitColor: 'transparent',
      borderColor: palette.border,
    },
    Button: {
      fontWeight: 500,
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Input: { paddingBlock: 7 },
    Segmented: { itemSelectedBg: '#FFFFFF', borderRadius: 8 },
    Tag: { borderRadiusSM: 6 },
    Statistic: { titleFontSize: 13 },
    Tabs: { titleFontSize: 14, inkBarColor: palette.primary },
  },
};
