import { Card, Skeleton } from 'antd';

/**
 * First-load placeholder for list pages (P2 #2): skeleton ROWS instead of the
 * overlay spinner, so the layout doesn't jump when data lands. Refetches keep
 * using the Table's own `loading` overlay (previous rows stay visible).
 */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Card>
      <Skeleton active title={false} paragraph={{ rows: 1, width: '38%' }} />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          key={i}
          active
          title={false}
          paragraph={{ rows: 1, width: '100%' }}
          style={{ marginTop: 10 }}
        />
      ))}
    </Card>
  );
}
