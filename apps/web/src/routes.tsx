import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useMe } from './lib/auth';
import { LoginPage } from './features/auth/LoginPage';
import { HomePage } from './features/home/HomePage';

function Protected({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading } = useMe();
  const location = useLocation();
  if (isLoading) return <Spin style={{ margin: 80 }} />;
  if (!me) {
    const returnUrl = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?returnUrl=${returnUrl}`} replace />;
  }
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <Protected>
            <HomePage />
          </Protected>
        }
      />
    </Routes>
  );
}
