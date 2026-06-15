import React from 'react';
import ReactDOM from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, App as AntApp } from 'antd';
import viVN from 'antd/locale/vi_VN';
import enUS from 'antd/locale/en_US';
import { BrowserRouter } from 'react-router-dom';
import './i18n';
import { AppRoutes } from './routes';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

/** AntD internals (DatePicker, Pagination, …) follow the app language (Story 11.2 AC3). */
function LocalizedConfigProvider({ children }: { children: React.ReactNode }) {
  const { i18n } = useTranslation();
  return <ConfigProvider locale={i18n.language === 'en' ? enUS : viVN}>{children}</ConfigProvider>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocalizedConfigProvider>
        <AntApp>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </AntApp>
      </LocalizedConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
