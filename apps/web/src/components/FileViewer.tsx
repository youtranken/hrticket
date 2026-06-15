import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Button, Space, Spin, Alert, Typography } from 'antd';
import {
  type AttachmentMeta,
  fileKind,
  canPreviewInline,
  mintAccessUrl,
  asDownloadUrl,
  humanSize,
} from '../lib/files';

const { Text } = Typography;

interface Props {
  attachment: AttachmentMeta;
  open: boolean;
  onClose: () => void;
}

/**
 * In-ticket viewer (Story 8.2). Mints a signed URL ONLY when opened (lazy AC1),
 * then renders by type: audio/video players seek via HTTP Range (8.1), images and
 * PDFs preview inline up to the fixed thresholds, everything else (and over-size
 * media) falls back to Download / Open-in-new-tab. A "Tải về" action is ALWAYS
 * present — even for codecs the browser can't play. TTL auto-heal (AC4): a media
 * error re-mints the URL ONCE so a token that expired during a long pause resumes
 * silently; if it still errors with a fresh URL (e.g. a codec the browser can't
 * decode) we STOP re-minting and show a clean fallback message — never a tight
 * re-mint loop, never a console error.
 */
const MAX_AUTO_HEAL = 1;

export function FileViewer({ attachment, open, onClose }: Props) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Counts auto-heal re-mints so an undecodable media file can't loop forever.
  const healCount = useRef(0);

  const kind = fileKind(attachment.mimeType);
  const previewable = canPreviewInline(attachment);

  const mint = useCallback(async (): Promise<string | null> => {
    setLoading(true);
    setError(false);
    try {
      const { url: fresh } = await mintAccessUrl(attachment.id);
      setUrl(fresh);
      return fresh;
    } catch {
      setError(true);
      setUrl(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [attachment.id]);

  // Mint on open; clear the URL + reset the heal budget on close so a reopen always
  // gets a fresh token and a fresh chance to auto-heal.
  useEffect(() => {
    if (open) {
      healCount.current = 0;
      void mint();
    } else {
      setUrl(null);
    }
  }, [open, mint]);

  /** A media element errored: re-mint once (covers an expired token mid-pause); past
   *  the budget, give up quietly and show the download fallback (AC4 — no loop). */
  const onMediaError = () => {
    if (healCount.current >= MAX_AUTO_HEAL) {
      setError(true);
      return;
    }
    healCount.current += 1;
    void mint();
  };

  /** Re-mint then run an action with the fresh URL (download / open tab / resume). */
  const withFreshUrl = async (use: (u: string) => void) => {
    const fresh = url ?? (await mint());
    if (fresh) use(fresh);
  };

  const doDownload = () =>
    withFreshUrl((u) => {
      window.location.assign(asDownloadUrl(u));
    });
  const doOpenTab = () =>
    withFreshUrl((u) => {
      window.open(u, '_blank', 'noopener');
    });

  const footer = (
    <Space>
      <Button onClick={doDownload}>{t('files.download')}</Button>
      {!previewable && kind !== 'audio' && kind !== 'video' && (
        <Button onClick={doOpenTab}>{t('files.openNewTab')}</Button>
      )}
      <Button type="primary" onClick={onClose}>
        {t('common.cancel')}
      </Button>
    </Space>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={footer}
      width={kind === 'pdf' || kind === 'video' ? 900 : 640}
      title={
        <Space>
          <Text strong>{attachment.fileName}</Text>
          <Text type="secondary">{humanSize(attachment.size)}</Text>
        </Space>
      }
      destroyOnHidden
    >
      {loading && <Spin style={{ margin: 40 }} />}
      {error && <Alert type="error" showIcon message={t('files.cannotPreview')} />}

      {url && !loading && !error && (
        <div style={{ textAlign: 'center' }}>
          {kind === 'audio' && (
            <audio controls src={url} onError={onMediaError} style={{ width: '100%' }} />
          )}

          {kind === 'video' && (
            <video
              controls
              src={url}
              onError={onMediaError}
              style={{ width: '100%', maxHeight: '70vh' }}
            />
          )}

          {kind === 'image' &&
            (previewable ? (
              <img
                src={url}
                alt={attachment.fileName}
                style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
              />
            ) : (
              <Alert type="info" showIcon message={t('files.tooLargeImage')} />
            ))}

          {kind === 'pdf' &&
            (previewable ? (
              <iframe
                src={url}
                title={attachment.fileName}
                style={{ width: '100%', height: '70vh', border: 'none' }}
              />
            ) : (
              <Alert type="info" showIcon message={t('files.tooLargePdf')} />
            ))}

          {kind === 'other' && <Alert type="info" showIcon message={t('files.cannotPreview')} />}
        </div>
      )}
    </Modal>
  );
}
