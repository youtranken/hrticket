import type { ReactNode } from 'react';
import { Typography } from 'antd';
import { palette } from '../theme';

const { Title, Text } = Typography;

/**
 * One consistent page header for the config/admin pages — a navy title, an optional
 * one-line description, and an optional right-aligned action slot. Keeps every settings
 * screen visually aligned with the rest of the app (a single titled block, not a loose
 * `Title` floating above bare cards).
 */
export function PageHeader({
  title,
  subtitle,
  extra,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        marginBottom: 20,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Title level={4} style={{ margin: 0, color: palette.primary }}>
          {title}
        </Title>
        {subtitle && (
          <Text type="secondary" style={{ display: 'block', marginTop: 2 }}>
            {subtitle}
          </Text>
        )}
      </div>
      {extra && <div style={{ flexShrink: 0 }}>{extra}</div>}
    </div>
  );
}
