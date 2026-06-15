import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Space, Typography, Tooltip } from 'antd';
import { type AttachmentMeta, fileKind, humanSize } from '../lib/files';
import { FileViewer } from './FileViewer';

const { Text } = Typography;

/** Emoji glyph per kind — consistent with the project's emoji badge vocabulary
 *  (CONVENTIONS §9), no icon dependency. */
function kindGlyph(mimeType: string): string {
  switch (fileKind(mimeType)) {
    case 'image':
      return '🖼';
    case 'pdf':
      return '📄';
    case 'audio':
      return '🎵';
    case 'video':
      return '🎬';
    default:
      return '📎';
  }
}

interface Props {
  attachment: AttachmentMeta;
}

/**
 * A file chip rendered from METADATA ONLY (Story 8.2). Opening a ticket makes NO
 * /api/files request — the card knows name/size/type/status from the ticket payload;
 * the signed URL is minted lazily by the viewer only when the user clicks (AC1).
 * A `blocked_unsafe` file is greyed, non-clickable, with a tooltip pointing the user
 * back to the original email (the bytes were never stored).
 */
export function FileCard({ attachment }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const blocked = attachment.status !== 'stored';

  const card = (
    <Card
      size="small"
      hoverable={!blocked}
      onClick={blocked ? undefined : () => setOpen(true)}
      style={{
        width: 240,
        cursor: blocked ? 'not-allowed' : 'pointer',
        opacity: blocked ? 0.55 : 1,
      }}
      styles={{ body: { padding: '10px 12px' } }}
    >
      <Space align="start">
        <span style={{ fontSize: 22, lineHeight: 1 }}>{blocked ? '⚠' : kindGlyph(attachment.mimeType)}</span>
        <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
          <Text
            strong
            ellipsis={{ tooltip: attachment.fileName }}
            style={{ maxWidth: 170, display: 'block' }}
          >
            {attachment.fileName}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {blocked ? t('files.blockedUnsafe') : humanSize(attachment.size)}
          </Text>
        </Space>
      </Space>
    </Card>
  );

  if (blocked) {
    return <Tooltip title={t('files.blockedHint')}>{card}</Tooltip>;
  }

  return (
    <>
      {card}
      <FileViewer attachment={attachment} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
