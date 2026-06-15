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
import { CategoriesPage } from './features/admin/CategoriesPage';
import { GroupsPage } from './features/admin/GroupsPage';
import { RolesPage } from './features/admin/RolesPage';
import { AuditLogPage } from './features/admin/AuditLogPage';
import { ReminderConfigPage } from './features/admin/ReminderConfigPage';
import { MailProtectionPage } from './features/admin/MailProtectionPage';
import { AttachmentConfigPage } from './features/admin/AttachmentConfigPage';
import { EmailConnectionPage } from './features/admin/EmailConnectionPage';
import { SettingsHubPage } from './features/admin/SettingsHubPage';
import { JunkPage } from './features/junk/JunkPage';
import { InboxPage, MyTicketsPage, PoolPage } from './features/inbox/InboxPage';
import { PendingPage } from './features/pending/PendingPage';
import { SearchResultsPage } from './features/search/SearchResultsPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { TicketDetailPage } from './features/ticket/TicketDetailPage';
import { AppShell } from './layout/AppShell';
import { ForbiddenPage } from './components/Placeholder';

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
        <Route path="inbox" element={<InboxPage />} />
        <Route path="tickets/:id" element={<TicketDetailPage />} />
        <Route path="my-tickets" element={<MyTicketsPage />} />
        <Route path="pool" element={<PoolPage />} />
        <Route path="pending" element={<PendingPage />} />
        <Route path="search" element={<SearchResultsPage />} />
        <Route
          path="reports"
          element={
            <RequireRole roles={['team_lead', 'admin', 'ssa']} me={me}>
              <ReportsPage />
            </RequireRole>
          }
        />
        <Route
          path="audit"
          element={
            <RequireRole roles={['team_lead', 'admin', 'ssa']} me={me}>
              <AuditLogPage />
            </RequireRole>
          }
        />
        <Route
          path="junk"
          element={
            <RequireRole roles={admin} me={me}>
              <JunkPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/categories"
          element={
            <RequireRole roles={admin} me={me}>
              <CategoriesPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/groups"
          element={
            <RequireRole roles={admin} me={me}>
              <GroupsPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/reminders"
          element={
            <RequireRole roles={admin} me={me}>
              <ReminderConfigPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/mail-protection"
          element={
            <RequireRole roles={admin} me={me}>
              <MailProtectionPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/attachments"
          element={
            <RequireRole roles={admin} me={me}>
              <AttachmentConfigPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/email-connection"
          element={
            <RequireRole roles={admin} me={me}>
              <EmailConnectionPage />
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
              <SettingsHubPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/roles"
          element={
            <RequireRole roles={['ssa']} me={me}>
              <RolesPage />
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
