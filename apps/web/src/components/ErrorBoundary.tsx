import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Result } from 'antd';
import { ServerErrorArt } from './illustrations/status';

function ErrorFallback() {
  const { t } = useTranslation();
  return (
    <Result
      icon={<ServerErrorArt size={200} />}
      title={t('errorBoundary.title')}
      subTitle={t('errorBoundary.desc')}
      extra={
        <Button type="primary" onClick={() => window.location.reload()}>
          {t('errorBoundary.reload')}
        </Button>
      }
    />
  );
}

/**
 * App-wide React error boundary (L6): a render-time throw shows a recoverable fallback
 * instead of unmounting the whole tree and blanking the SPA (React 19 behaviour). A
 * class component is required — error boundaries have no hooks equivalent.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('Unhandled render error:', error);
  }

  override render(): ReactNode {
    return this.state.hasError ? <ErrorFallback /> : this.props.children;
  }
}
