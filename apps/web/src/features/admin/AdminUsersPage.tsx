import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, Table, Button, Tag, Modal, Typography, App as AntApp } from 'antd';
import { api } from '../../lib/apiClient';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: boolean;
}

/** Minimal user admin (Story 1.7): list + reset password / remove OTP. Story 9.2 expands. */
export function AdminUsersPage() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { data: users = [], refetch } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<AdminUser[]>('/admin/users'),
  });

  const resetPassword = async (id: string) => {
    const res = await api<{ tempPassword: string }>(`/admin/users/${id}/reset-password`, {
      method: 'POST',
    });
    Modal.info({
      title: 'Mật khẩu tạm (hiện 1 lần)',
      content: <Typography.Text copyable>{res.tempPassword}</Typography.Text>,
    });
    await refetch();
  };

  const removeOtp = async (id: string) => {
    await api(`/admin/users/${id}/remove-otp`, { method: 'POST' });
    message.success('Đã gỡ OTP');
  };

  return (
    <Card title={t('menu.users')}>
      <Table<AdminUser>
        rowKey="id"
        dataSource={users}
        pagination={false}
        columns={[
          { title: t('common.email'), dataIndex: 'email' },
          { title: 'Tên', dataIndex: 'name' },
          { title: 'Vai trò', dataIndex: 'role' },
          {
            title: 'Trạng thái',
            dataIndex: 'disabled',
            render: (d: boolean) => (d ? <Tag color="red">disabled</Tag> : <Tag color="green">active</Tag>),
          },
          {
            title: '',
            render: (_: unknown, u: AdminUser) => (
              <>
                <Button size="small" onClick={() => resetPassword(u.id)}>
                  Reset mật khẩu
                </Button>{' '}
                <Button size="small" onClick={() => removeOtp(u.id)}>
                  Gỡ OTP
                </Button>
              </>
            ),
          },
        ]}
      />
    </Card>
  );
}
