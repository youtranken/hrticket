import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WarningOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  Progress,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from 'antd';
import { useAttachmentConfig, useSaveAttachmentConfig } from '../../lib/attachmentConfig';

const { Title, Text } = Typography;

function humanGb(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Admin "Attachment settings" (Story 8.4): allowed-format chips (with a warning for
 *  formats the sniffer can't verify), the soft size cap, the three auto-tag toggles,
 *  the disk-low threshold, and a live storage-usage bar. Everything hot-reloads for
 *  ingest + upload on save (no restart). */
export function AttachmentConfigPage() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { data: cfg } = useAttachmentConfig();
  const save = useSaveAttachmentConfig();

  const [extensions, setExtensions] = useState<string[]>([]);
  const [capMb, setCapMb] = useState(50);
  const [diskAlertPct, setDiskAlertPct] = useState(15);
  const [autotag, setAutotag] = useState({ attachment: true, crosspost: true, autoreply: true });
  const [newExt, setNewExt] = useState('');

  useEffect(() => {
    if (cfg) {
      setExtensions(cfg.allowedExtensions);
      setCapMb(cfg.capMb);
      setDiskAlertPct(cfg.diskAlertPct);
      setAutotag(cfg.autotag);
    }
  }, [cfg]);

  const knownWarning = new Set(cfg?.signatureWarning ?? []);

  const addExt = () => {
    const e = newExt.trim().toLowerCase().replace(/^\./, '');
    if (e && !extensions.includes(e)) setExtensions([...extensions, e]);
    setNewExt('');
  };
  const removeExt = (e: string) => setExtensions(extensions.filter((x) => x !== e));

  const onSave = () =>
    save.mutate(
      { allowedExtensions: extensions, capMb, diskAlertPct, autotag },
      {
        onSuccess: () => message.success(t('common.saved')),
        onError: (e) => message.error(e.message),
      },
    );

  const disk = cfg?.disk;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 760 }}>
      <Title level={4}>{t('files.cfg.title')}</Title>

      {disk && (
        <Card title={t('files.cfg.diskTitle')}>
          <Progress
            percent={disk.usedPct}
            status={disk.freePct < diskAlertPct ? 'exception' : 'normal'}
          />
          <Text type="secondary">
            {t('files.cfg.diskUsage', {
              used: humanGb(disk.usedBytes),
              total: humanGb(disk.totalBytes),
              free: disk.freePct,
            })}
          </Text>
          {disk.freePct < diskAlertPct && (
            <Alert style={{ marginTop: 12 }} type="warning" showIcon message={t('files.cfg.diskLow')} />
          )}
        </Card>
      )}

      <Card title={t('files.cfg.formatsTitle')}>
        <Space wrap style={{ marginBottom: 12 }}>
          {extensions.map((e) =>
            knownWarning.has(e) ? (
              <Tooltip key={e} title={t('files.cfg.noSignature')}>
                <Tag color="warning" icon={<WarningOutlined />} closable onClose={() => removeExt(e)}>
                  {e}
                </Tag>
              </Tooltip>
            ) : (
              <Tag key={e} color="blue" closable onClose={() => removeExt(e)}>
                {e}
              </Tag>
            ),
          )}
        </Space>
        <Space>
          <Input
            placeholder={t('files.cfg.addFormat')}
            value={newExt}
            onChange={(ev) => setNewExt(ev.target.value)}
            onPressEnter={addExt}
            style={{ width: 160 }}
          />
          <Button onClick={addExt}>{t('common.add')}</Button>
        </Space>
      </Card>

      <Card title={t('files.cfg.capTitle')}>
        <Space>
          <Text>{t('files.cfg.capMb')}</Text>
          <InputNumber min={1} max={10000} value={capMb} onChange={(v) => setCapMb(v ?? 50)} addonAfter="MB" />
        </Space>
      </Card>

      <Card title={t('files.cfg.autotagTitle')}>
        <Space direction="vertical">
          <Space>
            <Switch
              checked={autotag.attachment}
              onChange={(v) => setAutotag({ ...autotag, attachment: v })}
            />
            <Text>{t('files.cfg.autotagAttachment')}</Text>
          </Space>
          <Space>
            <Switch
              checked={autotag.crosspost}
              onChange={(v) => setAutotag({ ...autotag, crosspost: v })}
            />
            <Text>{t('files.cfg.autotagCrosspost')}</Text>
          </Space>
          <Space>
            <Switch
              checked={autotag.autoreply}
              onChange={(v) => setAutotag({ ...autotag, autoreply: v })}
            />
            <Text>{t('files.cfg.autotagAutoreply')}</Text>
          </Space>
        </Space>
      </Card>

      <Card title={t('files.cfg.diskThresholdTitle')}>
        <Space>
          <Text>{t('files.cfg.diskThreshold')}</Text>
          <InputNumber
            min={1}
            max={99}
            value={diskAlertPct}
            onChange={(v) => setDiskAlertPct(v ?? 15)}
            addonAfter="%"
          />
        </Space>
      </Card>

      <Button type="primary" onClick={onSave} loading={save.isPending}>
        {t('common.save')}
      </Button>
    </Space>
  );
}
