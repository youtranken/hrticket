import { Empty } from 'antd';
import type { ReactNode } from 'react';

/**
 * A branded empty state: one of the navy+gold illustrations (see ./illustrations)
 * over a description, with an optional action below. Wraps AntD `<Empty>` so it drops
 * straight into a table `locale.emptyText` or a dropdown, keeping AntD's spacing/i18n.
 * The `.empty-art` class gives the illustration its mount + gentle float animation.
 */
export function EmptyState({
  art,
  description,
  imageHeight = 120,
  children,
}: {
  art: ReactNode;
  description?: ReactNode;
  imageHeight?: number;
  children?: ReactNode;
}) {
  return (
    <Empty
      image={<span className="empty-art">{art}</span>}
      imageStyle={{ height: imageHeight, display: 'flex', justifyContent: 'center' }}
      description={description}
    >
      {children}
    </Empty>
  );
}
