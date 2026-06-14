import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
  Upload,
  Modal,
  Input,
} from 'antd';
import {
  useReplyDefaults,
  useReply,
  useNote,
  useDraft,
  putDraft,
  deleteDraft,
  uploadAttachment,
  type UploadedAttachment,
} from '../../lib/tickets';

const { Text } = Typography;

const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'mp3', 'mp4'];
const MAX_MB = 50;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

interface Props {
  ticketId: string;
}

/**
 * Reply (3.2) and Internal Note (3.4) compose box. Two clearly-separated tabs with
 * DIFFERENT submit buttons + editor colours (C3 — you can never confuse the mode).
 * Reply confirms when the recipient list differs from the default reply-all OR the
 * ticket is sensitive OR the server flags a brand-new recipient. Drafts autosave
 * server-side (3.5), per (ticket,user,kind).
 */
export function ComposeBox({ ticketId }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [tab, setTab] = useState<'reply' | 'note'>('reply');

  const defaults = useReplyDefaults(ticketId, true);
  const replyDraft = useDraft(ticketId, 'reply');
  const noteDraft = useDraft(ticketId, 'note');
  const reply = useReply(ticketId);
  const note = useNote(ticketId);

  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [replyBody, setReplyBody] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [draftLabel, setDraftLabel] = useState<{ reply?: string; note?: string }>({});
  const [confirm, setConfirm] = useState<{ recipients: string[]; newRecipients?: string[]; sensitive: boolean } | null>(null);

  // Seed recipients from the draft (preferred) or the reply-all default — once.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    if (replyDraft.isLoading || defaults.isLoading) return;
    const dr = replyDraft.data;
    if (dr) {
      setReplyBody(dr.body);
      if (dr.recipients) {
        setTo(dr.recipients.to ?? defaults.data?.to ?? []);
        setCc(dr.recipients.cc ?? defaults.data?.cc ?? []);
        setBcc(dr.recipients.bcc ?? []);
      } else if (defaults.data) {
        setTo(defaults.data.to);
        setCc(defaults.data.cc);
      }
      setDraftLabel((p) => ({ ...p, reply: dr.updatedAt }));
    } else if (defaults.data) {
      setTo(defaults.data.to);
      setCc(defaults.data.cc);
    }
    if (noteDraft.data) {
      setNoteBody(noteDraft.data.body);
      setDraftLabel((p) => ({ ...p, note: noteDraft.data!.updatedAt }));
    }
    seeded.current = true;
  }, [replyDraft.isLoading, defaults.isLoading, replyDraft.data, defaults.data, noteDraft.data]);

  // Autosave (debounced 2s) + flush on tab hide. Independent per kind (AC4).
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!seeded.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (tab === 'reply') {
        if (replyBody) void putDraft(ticketId, 'reply', replyBody, { to, cc, bcc }).then((r) => setDraftLabel((p) => ({ ...p, reply: r.updatedAt })));
      } else if (noteBody) {
        void putDraft(ticketId, 'note', noteBody).then((r) => setDraftLabel((p) => ({ ...p, note: r.updatedAt })));
      }
    }, 2000);
    return () => timer.current && clearTimeout(timer.current);
  }, [replyBody, noteBody, to, cc, bcc, tab, ticketId]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') {
        if (replyBody) void putDraft(ticketId, 'reply', replyBody, { to, cc, bcc });
        if (noteBody) void putDraft(ticketId, 'note', noteBody);
      }
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [replyBody, noteBody, to, cc, bcc, ticketId]);

  const submitReply = (confirmNewRecipients?: boolean) => {
    reply.mutate(
      { to, cc, bcc, body: replyBody, attachmentIds: attachments.map((a) => a.id), confirmNewRecipients },
      {
        onSuccess: (res) => {
          if ('needsConfirm' in res) {
            setConfirm({ recipients: [...to, ...cc, ...bcc], newRecipients: res.newRecipients, sensitive: defaults.data?.isSensitive ?? false });
            return;
          }
          message.success(t('compose.sent'));
          void deleteDraft(ticketId, 'reply');
          setReplyBody('');
          setAttachments([]);
          setConfirm(null);
          setDraftLabel((p) => ({ ...p, reply: undefined }));
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  const onSendClick = () => {
    const differs =
      !sameSet(to, defaults.data?.to ?? []) || !sameSet(cc, defaults.data?.cc ?? []) || bcc.length > 0;
    const sensitive = defaults.data?.isSensitive ?? false;
    if (differs || sensitive) {
      setConfirm({ recipients: [...to, ...cc, ...bcc], sensitive });
    } else {
      submitReply();
    }
  };

  const submitNote = () => {
    note.mutate(
      { body: noteBody },
      {
        onSuccess: () => {
          message.success(t('compose.noteSaved'));
          void deleteDraft(ticketId, 'note');
          setNoteBody('');
          setDraftLabel((p) => ({ ...p, note: undefined }));
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  const beforeUpload = (file: File): boolean => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXT.includes(ext) || file.size > MAX_MB * 1024 * 1024) {
      message.error(t('compose.attachReject'));
      return false;
    }
    void uploadAttachment(ticketId, file)
      .then((a) => setAttachments((p) => [...p, a]))
      .catch(() => message.error(t('compose.attachReject')));
    return false; // we upload manually
  };

  const discardDraft = (kind: 'reply' | 'note') => {
    void deleteDraft(ticketId, kind);
    if (kind === 'reply') setReplyBody('');
    else setNoteBody('');
    setDraftLabel((p) => ({ ...p, [kind]: undefined }));
  };

  const vnTime = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '');

  const replyPane = (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Select mode="tags" value={to} onChange={setTo} placeholder={t('compose.to')} style={{ width: '100%' }} tokenSeparators={[',', ' ']} />
      <Select mode="tags" value={cc} onChange={setCc} placeholder={t('compose.cc')} style={{ width: '100%' }} tokenSeparators={[',', ' ']} />
      <Select mode="tags" value={bcc} onChange={setBcc} placeholder={t('compose.bcc')} style={{ width: '100%' }} tokenSeparators={[',', ' ']} />
      <Input.TextArea
        value={replyBody}
        onChange={(e) => setReplyBody(e.target.value)}
        placeholder={t('compose.replyPlaceholder')}
        autoSize={{ minRows: 4, maxRows: 12 }}
      />
      {attachments.length > 0 && (
        <Space wrap>
          {attachments.map((a) => (
            <Tag key={a.id} closable color="blue" onClose={() => setAttachments((p) => p.filter((x) => x.id !== a.id))}>
              📎 {a.fileName}
            </Tag>
          ))}
        </Space>
      )}
      <Space>
        <Button type="primary" loading={reply.isPending} disabled={!replyBody || to.length === 0} onClick={onSendClick}>
          {t('compose.send')}
        </Button>
        <Upload beforeUpload={beforeUpload} showUploadList={false} multiple>
          <Button>{t('compose.attach')}</Button>
        </Upload>
        {draftLabel.reply && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('compose.draftSavedAt', { time: vnTime(draftLabel.reply) })}{' '}
            <a onClick={() => discardDraft('reply')}>{t('compose.discardDraft')}</a>
          </Text>
        )}
      </Space>
    </Space>
  );

  const notePane = (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Alert type="warning" showIcon message={t('compose.noteHint')} />
      <Input.TextArea
        value={noteBody}
        onChange={(e) => setNoteBody(e.target.value)}
        placeholder={t('compose.notePlaceholder')}
        autoSize={{ minRows: 4, maxRows: 12 }}
        style={{ background: '#fffbe6' }}
      />
      <Space>
        <Button loading={note.isPending} disabled={!noteBody} onClick={submitNote}>
          {t('compose.saveNote')}
        </Button>
        {draftLabel.note && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('compose.draftSavedAt', { time: vnTime(draftLabel.note) })}{' '}
            <a onClick={() => discardDraft('note')}>{t('compose.discardDraft')}</a>
          </Text>
        )}
      </Space>
    </Space>
  );

  return (
    <Card size="small">
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'reply' | 'note')}
        items={[
          { key: 'reply', label: t('compose.reply'), children: replyPane },
          { key: 'note', label: t('compose.note'), children: notePane },
        ]}
      />

      <Modal
        open={!!confirm}
        title={t('compose.confirmTitle')}
        okText={t('compose.confirmSend')}
        cancelText={t('common.cancel')}
        onOk={() => submitReply(true)}
        onCancel={() => setConfirm(null)}
        confirmLoading={reply.isPending}
      >
        {confirm?.sensitive && <Alert type="error" showIcon message={t('compose.sensitiveWarn')} style={{ marginBottom: 12 }} />}
        {confirm?.newRecipients && confirm.newRecipients.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('compose.confirmNewRecipients')}
            description={confirm.newRecipients.map((e) => (
              <Tag color="orange" key={e}>
                {e}
              </Tag>
            ))}
          />
        )}
        <Text>{t('compose.confirmRecipientList')}</Text>
        <div style={{ marginTop: 8 }}>
          {confirm?.recipients.map((e) => (
            <Tag key={e}>{e}</Tag>
          ))}
        </div>
      </Modal>
    </Card>
  );
}
