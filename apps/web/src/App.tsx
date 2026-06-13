import { useQuery } from '@tanstack/react-query';
import { Card, Typography, Tag, Spin } from 'antd';

const { Title, Paragraph } = Typography;

/** Bootstrap shell (Story 1.1). App shell + permission sidebar arrive in Story 1.8. */
export function App() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['ping'],
    queryFn: async () => {
      const res = await fetch('/api/ping');
      if (!res.ok) throw new Error('api unreachable');
      return res.json() as Promise<{ pong: boolean }>;
    },
  });

  return (
    <div style={{ maxWidth: 640, margin: '64px auto', padding: 24 }}>
      <Card>
        <Title level={3}>HRIS / C&B Ticket Management</Title>
        <Paragraph type="secondary">
          Bootstrap scaffold — Story 1.1. App shell &amp; permission sidebar land in Story 1.8.
        </Paragraph>
        <Paragraph>
          API status:{' '}
          {isLoading ? (
            <Spin size="small" />
          ) : isError ? (
            <Tag color="red">unreachable</Tag>
          ) : data?.pong ? (
            <Tag color="green">connected</Tag>
          ) : (
            <Tag>unknown</Tag>
          )}
        </Paragraph>
      </Card>
    </div>
  );
}
