import React from 'react';
import ReactDOM from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, App as AntApp } from 'antd';
import viVN from 'antd/locale/vi_VN';
import enUS from 'antd/locale/en_US';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/be-vietnam-pro/700.css';
import '@fontsource/jetbrains-mono/500.css';
import './index.css';
import './i18n';
import { appTheme } from './theme';
import { AppRoutes } from './routes';
import { ErrorBoundary } from './components/ErrorBoundary';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

/** AntD internals (DatePicker, Pagination, …) follow the app language (Story 11.2 AC3). */
function LocalizedConfigProvider({ children }: { children: React.ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <ConfigProvider theme={appTheme} locale={i18n.language === 'en' ? enUS : viVN}>
      {children}
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocalizedConfigProvider>
        <AntApp>
          <ErrorBoundary>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </ErrorBoundary>
        </AntApp>
      </LocalizedConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
