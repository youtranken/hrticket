import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Modal, Input, Badge, Space, Switch, App as AntApp } from 'antd';
import { useMe } from '../../lib/auth';
import { setMyAvailability, isAwayNow } from '../../lib/tickets';

function todayVn(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}
function ddmm(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

/** Header control to toggle "Vắng mặt" with an optional date range (Story 4.3). The
 *  badge reflects the current state; clearing it returns to "Sẵn sàng". Uses native
 *  date inputs (no extra date lib). */
export function AvailabilityMenu() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [away, setAway] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [saving, setSaving] = useState(false);

  if (!me) return null;
  const awayNow = isAwayNow(me.availability.awayFrom, me.availability.awayTo);

  const openModal = () => {
    setAway(awayNow);
    setFrom(me.availability.awayFrom ?? todayVn());
    setTo(me.availability.awayTo ?? '');
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      if (!away) {
        await setMyAvailability(null, null);
      } else {
        await setMyAvailability(from || todayVn(), to || null);
      }
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['tickets'] });
      message.success(t('availability.saved'));
      setOpen(false);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* A status chip with a coloured dot (green = ready, amber = away) so the current
          availability reads at a glance in the header. */}
      <Button size="small" type="text" aria-label={t('availability.title')} onClick={openModal}>
        {awayNow ? (
          <Badge
            status="warning"
            text={
              me.availability.awayTo
                ? t('availability.awayUntil', { date: ddmm(me.availability.awayTo) })
                : t('availability.away')
            }
          />
        ) : (
          <Badge status="success" text={t('availability.available')} />
        )}
      </Button>
      <Modal open={open} title={t('availability.title')} onOk={save} onCancel={() => setOpen(false)} confirmLoading={saving}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Switch checked={away} onChange={setAway} />
            <span>{t('availability.away')}</span>
          </Space>
          {away && (
            <Space>
              <label>
                {t('availability.from')}{' '}
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
              </label>
              <label>
                {t('availability.toOpen')}{' '}
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
              </label>
            </Space>
          )}
        </Space>
      </Modal>
    </>
  );
}
