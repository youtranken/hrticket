import { useState } from 'react';
import { Modal, Form, Input, Select, Upload, Button, App as AntApp } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd/es/upload/interface';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useMe } from '../../lib/auth';
import { useUploadPolicy } from '../../lib/files';

// FALLBACK only (mirrors the seed) while /upload-policy is in flight — the live
// gate is the admin-editable attachment config, same as ComposeBox.
const FALLBACK_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'mp3', 'mp4'];
const FALLBACK_MAX_MB = 50;
import { useFilterOptions, createManualTicket } from '../../lib/tickets';
import i18n from '../../i18n';

interface FormValues {
  recipientEmail: string;
  subject: string;
  categoryId?: number;
  assigneeId?: string;
  body: string;
}

/** Create a ticket by hand: recipient + subject + (optional) category + body + files.
 *  On submit it creates the ticket AND sends the opening mail in one request, then jumps
 *  to the new ticket. Category blank = auto-classify; assignee blank = pool/auto-assign.
 *  A Member creator self-owns; only Admin/TL see the assignee picker (they hand it off). */
export function CreateTicketModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: opts } = useFilterOptions();
  const [form] = Form.useForm<FormValues>();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false);
  const lang = i18n.language === 'en' ? 'en' : 'vi';
  const policy = useUploadPolicy();
  const allowedExt = policy.data?.allowedExtensions.length
    ? policy.data.allowedExtensions
    : FALLBACK_EXT;
  const capMb = policy.data?.capMb ?? FALLBACK_MAX_MB;
  const isCoordinator = me?.role === 'admin' || me?.role === 'team_lead';

  const submit = async (values: FormValues) => {
    setBusy(true);
    try {
      const files = fileList.map((f) => f.originFileObj as File).filter(Boolean);
      const res = await createManualTicket({
        recipientEmail: values.recipientEmail.trim(),
        subject: values.subject.trim(),
        body: values.body,
        categoryId: values.categoryId,
        assigneeId: values.assigneeId,
        files,
      });
      message.success(t('manualTicket.created', { code: res.ticketCode }));
      form.resetFields();
      setFileList([]);
      onClose();
      qc.invalidateQueries({ queryKey: ['tickets'] });
      navigate(`/tickets/${res.ticketId}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('manualTicket.title')}
      okText={t('manualTicket.submit')}
      onOk={() => form.submit()}
      onCancel={onClose}
      confirmLoading={busy}
      destroyOnClose
      width={620}
    >
      <Form form={form} layout="vertical" onFinish={submit} preserve={false}>
        <Form.Item
          label={t('manualTicket.recipient')}
          name="recipientEmail"
          rules={[{ required: true, type: 'email', message: t('manualTicket.recipientInvalid') }]}
        >
          <Input placeholder="nguoinhan@example.com" />
        </Form.Item>
        <Form.Item
          label={t('manualTicket.subject')}
          name="subject"
          rules={[{ required: true, message: t('manualTicket.subjectRequired') }]}
        >
          <Input maxLength={500} />
        </Form.Item>
        <Form.Item label={t('manualTicket.category')} name="categoryId" extra={t('manualTicket.categoryHint')}>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder={t('manualTicket.categoryAuto')}
            options={(opts?.categories ?? []).map((c) => ({
              value: c.id,
              label: lang === 'en' ? c.nameEn : c.nameVi,
            }))}
          />
        </Form.Item>
        {isCoordinator && (
          <Form.Item label={t('manualTicket.assignee')} name="assigneeId" extra={t('manualTicket.assigneeHint')}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('manualTicket.assigneePool')}
              options={(opts?.assignees ?? []).filter((a) => !a.disabled).map((a) => ({ value: a.id, label: a.name }))}
            />
          </Form.Item>
        )}
        <Form.Item
          label={t('manualTicket.body')}
          name="body"
          rules={[{ required: true, message: t('manualTicket.bodyRequired') }]}
        >
          <Input.TextArea rows={6} maxLength={50000} showCount />
        </Form.Item>
        <Form.Item label={t('manualTicket.attachments')}>
          <Upload
            multiple
            fileList={fileList}
            accept={allowedExt.map((e) => `.${e}`).join(',')}
            // Gate type + size HERE instead of bouncing off the server after submit;
            // returning false (not uploading) is the existing manual-send behaviour.
            beforeUpload={(file) => {
              const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
              if (!allowedExt.includes(ext) || file.size > capMb * 1024 * 1024) {
                message.error(t('compose.attachReject'));
                return Upload.LIST_IGNORE;
              }
              return false;
            }}
            onChange={({ fileList: fl }) => setFileList(fl)}
          >
            <Button icon={<UploadOutlined />}>{t('manualTicket.addFile')}</Button>
          </Upload>
        </Form.Item>
      </Form>
    </Modal>
  );
}
