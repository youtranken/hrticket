import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dropdown, Modal, Input, Checkbox, Space, App as AntApp } from 'antd';
// Confirms use the context-aware `modal` from App.useApp() (static Modal.confirm does
// not render reliably under the App provider with React 19).
import type { MenuProps } from 'antd';
import { manualNextStates, REOPEN_WARN_THRESHOLD, type TicketStatus } from '@hris/shared';
import { useMe } from '../../lib/auth';
import { useChangeStatus, useSetReopenLock, type TicketDetail } from '../../lib/tickets';

/**
 * Lifecycle action bar on the ticket detail (Stories 5.1/5.2/5.4/5.5): a
 * "Chuyển trạng thái" dropdown limited to the state machine's legal next steps, the
 * Pending snooze modal (date + reason), the close confirm (with "đóng hộ" when acting
 * on someone else's ticket), and the reopen-lock tickbox once a ticket has been
 * reopened past the warn threshold. Mirrors the server's canActOnTicket — a Member
 * who isn't the assignee sees nothing (UX only; the server is the real gate).
 */
export function LifecycleControls({ ticket }: { ticket: TicketDetail['ticket'] }) {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: me } = useMe();
  const changeStatus = useChangeStatus(ticket.id);
  const setLock = useSetReopenLock(ticket.id);

  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState('');
  const [snoozeNote, setSnoozeNote] = useState('');

  const inGroup = ticket.categoryId !== null && (me?.groups ?? []).includes(ticket.categoryId);
  const isAdmin = me?.role === 'ssa' || me?.role === 'admin';
  const mine = ticket.assignee?.id === me?.user.id;
  const canAct = isAdmin || mine || (me?.role === 'team_lead' && inGroup);
  if (!canAct) return null;

  const next = manualNextStates(ticket.status as TicketStatus);

  const doChange = (to: string) =>
    changeStatus.mutate(
      { to },
      {
        onSuccess: () => message.success(t('lifecycle.changed')),
        onError: (e) => message.error(e.message),
      },
    );

  const confirmClose = () =>
    modal.confirm({
      title: mine ? t('lifecycle.confirmClose') : t('lifecycle.confirmCloseForOther'),
      okText: t('lifecycle.close'),
      onOk: () => doChange('closed'),
    });

  const onPick = (to: string) => {
    if (to === 'pending') setSnoozeOpen(true);
    else if (to === 'closed') confirmClose();
    else doChange(to);
  };

  const menuItems: MenuProps['items'] = next.map((s) => ({
    key: s,
    label: t(`lifecycle.to.${s}`),
  }));

  const submitSnooze = () => {
    if (!snoozeDate) return;
    changeStatus.mutate(
      { to: 'pending', snoozeUntil: snoozeDate, note: snoozeNote || undefined },
      {
        onSuccess: () => {
          message.success(t('lifecycle.snoozed'));
          setSnoozeOpen(false);
          setSnoozeDate('');
          setSnoozeNote('');
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  const showLock = ticket.reopenLocked || ticket.reopenCount > REOPEN_WARN_THRESHOLD;

  return (
    <Space wrap>
      {next.length > 0 && (
        <Dropdown
          menu={{ items: menuItems, onClick: ({ key }) => onPick(key) }}
          disabled={changeStatus.isPending}
        >
          <Button>{t('lifecycle.changeStatus')} ▾</Button>
        </Dropdown>
      )}

      {showLock && (
        <Checkbox
          checked={ticket.reopenLocked}
          disabled={setLock.isPending}
          onChange={(e) => {
            const locked = e.target.checked;
            modal.confirm({
              title: locked ? t('lifecycle.confirmLock') : t('lifecycle.confirmUnlock'),
              onOk: () =>
                setLock.mutate(
                  { locked },
                  {
                    onSuccess: () =>
                      message.success(locked ? t('lifecycle.locked') : t('lifecycle.unlocked')),
                    onError: (err) => message.error(err.message),
                  },
                ),
            });
          }}
        >
          {t('lifecycle.lockReopen')}
        </Checkbox>
      )}

      {/* Pending: a future date is mandatory (server 422s otherwise). Native date
          input — the app deliberately avoids dayjs (AntD DatePicker dep). */}
      <Modal
        open={snoozeOpen}
        title={t('lifecycle.snoozeTitle')}
        okText={t('lifecycle.to.pending')}
        okButtonProps={{ disabled: !snoozeDate, loading: changeStatus.isPending }}
        onOk={submitSnooze}
        onCancel={() => setSnoozeOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            type="date"
            value={snoozeDate}
            onChange={(e) => setSnoozeDate(e.target.value)}
            aria-label={t('lifecycle.snoozeUntil')}
          />
          <Input.TextArea
            value={snoozeNote}
            onChange={(e) => setSnoozeNote(e.target.value)}
            placeholder={t('lifecycle.snoozeNote')}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        </Space>
      </Modal>
    </Space>
  );
}
