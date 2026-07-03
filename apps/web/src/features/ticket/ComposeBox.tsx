import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Dropdown,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
  Upload,
  Modal,
  Input,
  Checkbox,
} from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { canTransition, type TicketStatus } from '@hris/shared';
import {
  useReplyDefaults,
  useReply,
  useForward,
  useNote,
  useDraft,
  useTicket,
  putDraft,
  deleteDraft,
  uploadAttachment,
  type TicketMessage,
  type UploadedAttachment,
} from '../../lib/tickets';
import { useReplyTemplates, fillTemplate } from '../../lib/replyTemplates';
import { useUploadPolicy } from '../../lib/files';
import { useMe } from '../../lib/auth';

const { Text } = Typography;

// FALLBACK only (mirrors the seed) while the /upload-policy fetch is in flight —
// the live gate comes from the admin-editable attachment config, not this list.
const FALLBACK_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'mp3', 'mp4'];
const FALLBACK_MAX_MB = 50;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

interface Props {
  ticketId: string;
  /** Current ticket status — gates the "Reply & Close" checkbox (5.2). */
  status: string;
  /** Message being forwarded (set by the bubble's "Forward" link) — opens the
   *  Forward tab with empty recipients, Gmail-style. */
  forward?: TicketMessage | null;
  /** Called when the forward is sent or cancelled — the page clears its selection. */
  onForwardDone?: () => void;
}

/**
 * Reply (3.2) and Internal Note (3.4) compose box. Two clearly-separated tabs with
 * DIFFERENT submit buttons + editor colours (C3 — you can never confuse the mode).
 * Reply confirms when the recipient list differs from the default reply-all OR the
 * ticket is sensitive OR the server flags a brand-new recipient. Drafts autosave
 * server-side (3.5), per (ticket,user,kind).
 */
export function ComposeBox({ ticketId, status, forward, onForwardDone }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { data: me } = useMe();
  const [tab, setTab] = useState<'reply' | 'note' | 'forward'>('reply');
  const [closeAfter, setCloseAfter] = useState(false);
  // Reply & Close is offered where closing is a legal shortcut (In Progress / Resolved),
  // PLUS Pending: replying wakes a snoozed ticket (Pending → In Progress on the server),
  // from which the close is legal — so "reply & close" works there too.
  const canCloseAfter =
    canTransition(status as TicketStatus, 'closed').ok || status === 'pending';

  const navigate = useNavigate();
  const defaults = useReplyDefaults(ticketId, true);
  const replyDraft = useDraft(ticketId, 'reply');
  const noteDraft = useDraft(ticketId, 'note');
  const reply = useReply(ticketId);
  const fwd = useForward(ticketId);
  const note = useNote(ticketId);
  // Canned reply templates: any agent may insert; only TL (who also replies) gets the
  // manage shortcut here (Admin/SSA manage from Settings — they don't see the reply tab).
  const ticket = useTicket(ticketId);
  const templates = useReplyTemplates();
  const policy = useUploadPolicy();
  const [tplSel, setTplSel] = useState<number>();

  // Mirror the SERVER reply gate exactly (review #7): the assignee — whatever the
  // role (đơn 5) — or a Team Lead of the ticket's group. A non-assignee member gets
  // no Reply/Forward UI (they claim first); the server (assertCanReplyTicket) is
  // still the real gate. While loading, keep the tab to avoid a flash.
  const isAssignee = !!me && ticket.data?.ticket.assignee?.id === me.user.id;
  const tlInGroup =
    me?.role === 'team_lead' &&
    ticket.data?.ticket.categoryId != null &&
    (me.groups ?? []).includes(ticket.data.ticket.categoryId);
  const canReply = me && ticket.data ? isAssignee || !!tlInGroup : true;

  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [replyBody, setReplyBody] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [draftLabel, setDraftLabel] = useState<{ reply?: string; note?: string }>({});
  const [confirm, setConfirm] = useState<{ recipients: string[]; newRecipients?: string[]; sensitive: boolean; mode: 'reply' | 'forward' } | null>(null);
  // Send-with-status (đơn 6): the send button's arrow menu — Pending asks for the
  // snooze date first; the chosen target rides along on submit.
  const [sendStatus, setSendStatus] = useState<'pending' | 'resolved' | undefined>(undefined);
  const [sendSnoozeOpen, setSendSnoozeOpen] = useState(false);
  const [sendSnoozeDate, setSendSnoozeDate] = useState('');

  // Forward mode: recipients start EMPTY (Gmail semantics — you choose who gets it).
  const [fTo, setFTo] = useState<string[]>([]);
  const [fCc, setFCc] = useState<string[]>([]);
  const [fBcc, setFBcc] = useState<string[]>([]);

  // mode="tags" accepts ANY free text as a recipient token — keep only valid
  // addresses and warn on what was dropped, so a typo can't become a bounce.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emailListSetter = (set: (v: string[]) => void) => (vals: string[]) => {
    const trimmed = vals.map((v) => v.trim()).filter(Boolean);
    const bad = trimmed.filter((v) => !EMAIL_RE.test(v));
    if (bad.length) message.warning(t('compose.invalidRecipient', { list: bad.join(', ') }));
    set(trimmed.filter((v) => EMAIL_RE.test(v)));
  };
  const [fBody, setFBody] = useState('');
  useEffect(() => {
    if (forward) {
      setFTo([]);
      setFCc([]);
      setFBcc([]);
      setFBody('');
      setTab('forward');
    } else {
      setTab((cur) => (cur === 'forward' ? 'reply' : cur));
    }
  }, [forward?.id]);

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
        setBcc(dr.recipients.bcc ?? defaults.data?.bcc ?? []);
      } else if (defaults.data) {
        setTo(defaults.data.to);
        setCc(defaults.data.cc);
        setBcc(defaults.data.bcc ?? []);
      }
      setDraftLabel((p) => ({ ...p, reply: dr.updatedAt }));
    } else if (defaults.data) {
      setTo(defaults.data.to);
      setCc(defaults.data.cc);
      setBcc(defaults.data.bcc ?? []);
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
    const save = () => {
      if (replyBody) void putDraft(ticketId, 'reply', replyBody, { to, cc, bcc });
      if (noteBody) void putDraft(ticketId, 'note', noteBody);
    };
    const flush = () => {
      if (document.visibilityState === 'hidden') save();
    };
    // beforeunload closes the 2s-debounce gap: closing the tab / refreshing right
    // after typing used to silently drop the last edits (visibilitychange alone
    // doesn't fire reliably on window close).
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('beforeunload', save);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('beforeunload', save);
    };
  }, [replyBody, noteBody, to, cc, bcc, ticketId]);

  const submitReply = (
    confirmNewRecipients?: boolean,
    statusAfter: 'pending' | 'resolved' | undefined = sendStatus,
    snoozeUntil: string = sendSnoozeDate,
  ) => {
    reply.mutate(
      {
        to,
        cc,
        bcc,
        body: replyBody,
        attachmentIds: attachments.map((a) => a.id),
        confirmNewRecipients,
        closeAfter,
        statusAfter,
        snoozeUntil: statusAfter === 'pending' && snoozeUntil ? snoozeUntil : undefined,
      },
      {
        onSuccess: (res) => {
          if ('needsConfirm' in res) {
            setConfirm({ recipients: [...to, ...cc, ...bcc], newRecipients: res.newRecipients, sensitive: defaults.data?.isSensitive ?? false, mode: 'reply' });
            return;
          }
          message.success(
            res.closed
              ? t('compose.sentAndClosed')
              : res.status === 'resolved'
                ? t('compose.sentAndResolved')
                : res.status === 'pending'
                  ? t('compose.sentAndSnoozed')
                  : t('compose.sent'),
          );
          void deleteDraft(ticketId, 'reply');
          setReplyBody('');
          setAttachments([]);
          setConfirm(null);
          setCloseAfter(false);
          setSendStatus(undefined);
          setSendSnoozeDate('');
          setDraftLabel((p) => ({ ...p, reply: undefined }));
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  /** Entry for both the main Send and the arrow-menu variants — remembers the
   *  status target so the recipient-confirm retry sends the same thing. */
  const beginSend = (statusAfter?: 'pending' | 'resolved', snoozeUntil?: string) => {
    setSendStatus(statusAfter);
    if (snoozeUntil !== undefined) setSendSnoozeDate(snoozeUntil);
    // BCC is compared against the server default too (review #8) — it is SEEDED from
    // the latest outbound now, so "any BCC at all" would nag on every send of a
    // thread that ever used BCC.
    const differs =
      !sameSet(to, defaults.data?.to ?? []) ||
      !sameSet(cc, defaults.data?.cc ?? []) ||
      !sameSet(bcc, defaults.data?.bcc ?? []);
    const sensitive = defaults.data?.isSensitive ?? false;
    if (differs || sensitive) {
      setConfirm({ recipients: [...to, ...cc, ...bcc], sensitive, mode: 'reply' });
    } else {
      submitReply(undefined, statusAfter, snoozeUntil ?? sendSnoozeDate);
    }
  };

  const submitForward = (confirmNewRecipients?: boolean) => {
    if (!forward) return;
    fwd.mutate(
      { to: fTo, cc: fCc, bcc: fBcc, body: fBody, ticketMessageId: forward.id, confirmNewRecipients },
      {
        onSuccess: (res) => {
          if ('needsConfirm' in res) {
            setConfirm({ recipients: [...fTo, ...fCc, ...fBcc], newRecipients: res.newRecipients, sensitive: defaults.data?.isSensitive ?? false, mode: 'forward' });
            return;
          }
          message.success(t('compose.forwarded'));
          setConfirm(null);
          onForwardDone?.();
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  const onForwardSendClick = () => {
    if (defaults.data?.isSensitive) {
      setConfirm({ recipients: [...fTo, ...fCc, ...fBcc], sensitive: true, mode: 'forward' });
    } else {
      submitForward();
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
    const allowed = policy.data?.allowedExtensions.length ? policy.data.allowedExtensions : FALLBACK_EXT;
    const capMb = policy.data?.capMb ?? FALLBACK_MAX_MB;
    if (!allowed.includes(ext) || file.size > capMb * 1024 * 1024) {
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

  const insertTemplate = (id: number) => {
    const tpl = templates.data?.find((x) => x.id === id);
    if (!tpl) return;
    const filled = fillTemplate(tpl.body, {
      ticketCode: ticket.data?.ticket.ticketCode,
      requesterName: ticket.data?.ticket.requesterEmail?.split('@')[0],
      agentName: me?.user.name,
    });
    setReplyBody((prev) => (prev ? `${prev}\n\n${filled}` : filled));
    setTplSel(undefined);
  };

  const replyPane = (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Select mode="tags" value={to} onChange={emailListSetter(setTo)} placeholder={t('compose.to')} style={{ width: '100%' }} tokenSeparators={[',', ' ']} />
      <Select mode="tags" value={cc} onChange={emailListSetter(setCc)} placeholder={t('compose.cc')} style={{ width: '100%' }} tokenSeparators={[',', ' ']} />
      <Select mode="tags" value={bcc} onChange={emailListSetter(setBcc)} placeholder={t('compose.bcc')} style={{ width: '100%' }} tokenSeparators={[',', ' ']} />
      {(templates.data?.length ?? 0) > 0 && (
        <Space wrap>
          <Select
            value={tplSel}
            onSelect={(v) => insertTemplate(v as number)}
            placeholder={t('compose.insertTemplate')}
            style={{ width: 280 }}
            showSearch
            optionFilterProp="label"
            options={(templates.data ?? []).map((tpl) => ({ value: tpl.id, label: tpl.title }))}
          />
          {me?.role === 'team_lead' && (
            <a onClick={() => navigate('/admin/reply-templates')}>{t('tpl.manage')}</a>
          )}
        </Space>
      )}
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
        <Space.Compact>
          <Button type="primary" loading={reply.isPending} disabled={!replyBody || to.length === 0} onClick={() => beginSend()}>
            {t('compose.send')}
          </Button>
          {/* Send-with-status (đơn 6): the arrow menu sends AND moves the ticket in one
              action — Pending asks for the follow-up date first. */}
          {['open', 'assigned', 'in_progress', 'pending'].includes(status) && (
            <Dropdown
              disabled={!replyBody || to.length === 0 || reply.isPending}
              menu={{
                items: [
                  { key: 'pending', label: t('compose.sendPending') },
                  { key: 'resolved', label: t('compose.sendResolved') },
                ],
                onClick: ({ key }) => {
                  if (key === 'pending') {
                    setSendSnoozeDate('');
                    setSendSnoozeOpen(true);
                  } else {
                    beginSend('resolved');
                  }
                },
              }}
            >
              <Button type="primary" icon={<DownOutlined />} aria-label={t('compose.sendWithStatus')} />
            </Dropdown>
          )}
        </Space.Compact>
        <Upload beforeUpload={beforeUpload} showUploadList={false} multiple>
          <Button>{t('compose.attach')}</Button>
        </Upload>
        {canCloseAfter && (
          <Checkbox checked={closeAfter} onChange={(e) => setCloseAfter(e.target.checked)}>
            {t('compose.closeAfter')}
          </Checkbox>
        )}
        {draftLabel.reply && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('compose.draftSavedAt', { time: vnTime(draftLabel.reply) })}{' '}
            <a onClick={() => discardDraft('reply')}>{t('compose.discardDraft')}</a>
          </Text>
        )}
      </Space>
    </Space>
  );

  const vnWhen = (iso?: string) =>
    iso ? new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : '';

  const forwardPane = (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {/* NOT closable: the banner's × used to silently cancel the whole forward —
          users read it as "dismiss this note". Cancelling stays on the explicit button. */}
      <Alert
        type="info"
        showIcon
        message={t('compose.forwardingOf', { from: forward?.fromAddr ?? '', time: vnWhen(forward?.createdAt) })}
        description={t('compose.forwardHint', { subject: `Fwd: ${ticket.data?.ticket.subject ?? ''}` })}
      />
      <Select mode="tags" value={fTo} onChange={emailListSetter(setFTo)} placeholder={t('compose.to')} style={{ width: '100%' }} tokenSeparators={[',', ' ']} />
      <Select mode="tags" value={fCc} onChange={emailListSetter(setFCc)} placeholder={t('compose.cc')} style={{ width: '100%' }} tokenSeparators={[',', ' ']} />
      <Select mode="tags" value={fBcc} onChange={emailListSetter(setFBcc)} placeholder={t('compose.bcc')} style={{ width: '100%' }} tokenSeparators={[',', ' ']} />
      <Input.TextArea
        value={fBody}
        onChange={(e) => setFBody(e.target.value)}
        placeholder={t('compose.forwardPlaceholder')}
        autoSize={{ minRows: 3, maxRows: 10 }}
      />
      <Space>
        <Button type="primary" loading={fwd.isPending} disabled={fTo.length === 0} onClick={onForwardSendClick}>
          {t('compose.forwardSend')}
        </Button>
        <Button onClick={() => onForwardDone?.()}>{t('common.cancel')}</Button>
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
        activeKey={canReply ? tab : 'note'}
        onChange={(k) => setTab(k as 'reply' | 'note' | 'forward')}
        items={[
          ...(canReply ? [{ key: 'reply', label: t('compose.reply'), children: replyPane }] : []),
          ...(canReply && forward
            ? [{ key: 'forward', label: t('compose.forward'), children: forwardPane }]
            : []),
          { key: 'note', label: t('compose.note'), children: notePane },
        ]}
      />

      <Modal
        open={!!confirm}
        title={t('compose.confirmTitle')}
        okText={t('compose.confirmSend')}
        cancelText={t('common.cancel')}
        onOk={() => (confirm?.mode === 'forward' ? submitForward(true) : submitReply(true))}
        onCancel={() => setConfirm(null)}
        confirmLoading={reply.isPending || fwd.isPending}
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

      {/* "Gửi & Chờ phản hồi" needs the follow-up date (server 422s without it) —
          native date input, same convention as the lifecycle snooze modal. */}
      <Modal
        open={sendSnoozeOpen}
        title={t('compose.sendPendingTitle')}
        okText={t('compose.sendPending')}
        okButtonProps={{ disabled: !sendSnoozeDate }}
        onOk={() => {
          setSendSnoozeOpen(false);
          beginSend('pending', sendSnoozeDate);
        }}
        onCancel={() => setSendSnoozeOpen(false)}
      >
        <Input
          type="date"
          min={new Date().toISOString().slice(0, 10)}
          value={sendSnoozeDate}
          onChange={(e) => setSendSnoozeDate(e.target.value)}
          aria-label={t('compose.sendPendingTitle')}
        />
      </Modal>
    </Card>
  );
}
