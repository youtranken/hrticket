import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useMe, type Me } from './lib/auth';
import { LoginPage } from './features/auth/LoginPage';
import { OtpPage } from './features/auth/OtpPage';
import { ForgotPage } from './features/auth/ForgotPage';
import { ResetPage } from './features/auth/ResetPage';
import { ChangePasswordPage } from './features/auth/ChangePasswordPage';
import { ProfilePage } from './features/profile/ProfilePage';
import { AdminUsersPage } from './features/admin/AdminUsersPage';
import { AppShell } from './layout/AppShell';
import { Placeholder, ForbiddenPage } from './components/Placeholder';

type Role = Me['role'];

function RequireRole({ roles, me, children }: { roles: Role[]; me: Me; children: React.ReactNode }) {
  return roles.includes(me.role) ? <>{children}</> : <ForbiddenPage />;
}

function ProtectedApp() {
  const { data: me, isLoading } = useMe();
  const location = useLocation();
  if (isLoading) return <Spin style={{ margin: 80 }} />;
  if (!me) {
    const returnUrl = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?returnUrl=${returnUrl}`} replace />;
  }
  // Forced password change blocks the whole app (Story 1.7).
  if (me.mustChangePassword) return <ChangePasswordPage forced />;

  const admin: Role[] = ['admin', 'ssa'];
  return (
    <AppShell>
      <Routes>
        <Route index element={<Navigate to="/inbox" replace />} />
        <Route path="inbox" element={<Placeholder titleKey="menu.inbox" />} />
        <Route path="my-tickets" element={<Placeholder titleKey="menu.myTickets" />} />
        <Route path="pending" element={<Placeholder titleKey="menu.pending" />} />
        <Route
          path="reports"
          element={
            <RequireRole roles={['team_lead', 'admin', 'ssa']} me={me}>
              <Placeholder titleKey="menu.reports" />
            </RequireRole>
          }
        />
        <Route
          path="audit"
          element={
            <RequireRole roles={['team_lead', 'admin', 'ssa']} me={me}>
              <Placeholder titleKey="menu.audit" />
            </RequireRole>
          }
        />
        <Route
          path="junk"
          element={
            <RequireRole roles={admin} me={me}>
              <Placeholder titleKey="menu.junk" />
            </RequireRole>
          }
        />
        <Route
          path="admin/users"
          element={
            <RequireRole roles={admin} me={me}>
              <AdminUsersPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/settings"
          element={
            <RequireRole roles={admin} me={me}>
              <Placeholder titleKey="menu.settings" />
            </RequireRole>
          }
        />
        <Route
          path="admin/roles"
          element={
            <RequireRole roles={['ssa']} me={me}>
              <Placeholder titleKey="menu.roles" />
            </RequireRole>
          }
        />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="*" element={<ForbiddenPage />} />
      </Routes>
    </AppShell>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/otp" element={<OtpPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset" element={<ResetPage />} />
      <Route path="/*" element={<ProtectedApp />} />
    </Routes>
  );
}
