import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Tabs,
  Table,
  Button,
  Input,
  InputNumber,
  Collapse,
  Select,
  Space,
  Tag,
  Form,
  Typography,
  App as AntApp,
} from 'antd';
import { EmptyState } from '../../components/EmptyState';
import { InboxZeroArt } from '../../components/illustrations/empty';
import {
  useBlocklist,
  useAddBlock,
  useRemoveBlock,
  type BlocklistEntry,
} from '../../lib/blocklist';
import {
  useAllowlist,
  useAddAllow,
  useRemoveAllow,
  type AllowlistEntry,
} from '../../lib/allowlist';
import {
  useSuppressed,
  useMailBombConfig,
  useSaveMailBombConfig,
  useReprocess,
  useIgnoreSuppressed,
  type SuppressedGroup,
  type SuppressedItem,
} from '../../lib/suppressed';
import {
  useJunkRules,
  useAddJunkRule,
  useRemoveJunkRule,
  type JunkRule,
} from '../../lib/junkRules';
import { fmtDateTime } from '../../lib/datetime';

const { Text } = Typography;

/**
 * Admin "Bảo vệ hộp thư" (Story 7.1+). One page hosting the mail-protection config:
 * the sender blocklist now; the mail-bomb threshold (7.2) and junk rules (7.3) add
 * their own tabs here later.
 */
export function MailProtectionPage() {
  const { t } = useTranslation();
  return (
    <Card title={t('spam.title')}>
      <Tabs
        items={[
          { key: 'blocklist', label: t('spam.blocklist.tab'), children: <BlocklistTab /> },
          { key: 'allowlist', label: t('spam.allowlist.tab'), children: <AllowlistTab /> },
          { key: 'held', label: t('spam.held.tab'), children: <HeldMailTab /> },
          { key: 'junkRules', label: t('spam.junkRules.tab'), children: <JunkRulesTab /> },
        ]}
      />
    </Card>
  );
}

function BlocklistTab() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: rows = [], isLoading } = useBlocklist();
  const { data: allowRows = [] } = useAllowlist();
  const add = useAddBlock();
  const remove = useRemoveBlock();
  const [form] = Form.useForm<{ email: string; reason?: string }>();

  const onAdd = (v: { email: string; reason?: string }) => {
    const doAdd = () =>
      add.mutate(v, {
        onSuccess: () => {
          message.success(t('spam.blocklist.added'));
          form.resetFields();
        },
        onError: (e) => message.error(e.message),
      });
    // Mirror of the allowlist-side warning: blocking a sender who is also on the
    // Allowlist wins over it — flag the overlap instead of leaving a stale allow row.
    const allowed = allowRows.some((r) => r.email.toLowerCase() === v.email.trim().toLowerCase());
    if (allowed) {
      modal.confirm({
        title: t('spam.conflictWithAllow', { email: v.email }),
        okButtonProps: { danger: true },
        onOk: doAdd,
      });
    } else {
      doAdd();
    }
  };

  const onRemove = (row: BlocklistEntry) => {
    modal.confirm({
      title: t('spam.blocklist.confirmRemove', { email: row.email }),
      okButtonProps: { danger: true },
      onOk: () =>
        remove
          .mutateAsync(row.id)
          .then(() => message.success(t('spam.blocklist.removed')))
          .catch((e: Error) => message.error(e.message)),
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Text type="secondary">{t('spam.blocklist.hint')}</Text>
      <Form form={form} layout="inline" onFinish={onAdd}>
        <Form.Item
          name="email"
          rules={[
            { required: true, message: t('spam.blocklist.emailRequired') },
            { type: 'email', message: t('spam.blocklist.emailInvalid') },
          ]}
        >
          <Input placeholder={t('spam.blocklist.emailPlaceholder')} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="reason">
          <Input placeholder={t('spam.blocklist.reasonPlaceholder')} style={{ width: 260 }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={add.isPending}>
          {t('spam.blocklist.addButton')}
        </Button>
      </Form>

      <Table<BlocklistEntry>
        rowKey="id"
        loading={isLoading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: t('spam.blocklist.colEmail'), dataIndex: 'email', width: 260 },
          {
            title: t('spam.blocklist.colReason'),
            dataIndex: 'reason',
            render: (r: string | null) => r ?? '—',
          },
          {
            title: t('spam.blocklist.colBlockedCount'),
            dataIndex: 'blockedCount',
            width: 130,
            render: (n: number) => <Tag color={n > 0 ? 'red' : 'default'}>{n}</Tag>,
          },
          {
            title: t('spam.blocklist.colAddedBy'),
            dataIndex: 'addedByEmail',
            render: (e: string | null) => e ?? '—',
          },
          {
            title: t('spam.blocklist.colDate'),
            dataIndex: 'createdAt',
            width: 170,
            render: (d: string) => fmtDateTime(d),
          },
          {
            title: '',
            width: 100,
            render: (_: unknown, row: BlocklistEntry) => (
              <Button size="small" danger onClick={() => onRemove(row)}>
                {t('spam.blocklist.unblock')}
              </Button>
            ),
          },
        ]}
      />
    </Space>
  );
}

/** Allowlist CRUD — the twin of the blocklist. An allowlisted sender's mail always
 *  opens a ticket even when it carries list/bulk/auto-submitted headers (e.g. HR
 *  announcements sent via a Google Group). Only relaxes that filter; blocklist /
 *  mail-bomb / junk still apply. */
function AllowlistTab() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: rows = [], isLoading } = useAllowlist();
  const { data: blockRows = [] } = useBlocklist();
  const add = useAddAllow();
  const remove = useRemoveAllow();
  const [form] = Form.useForm<{ email: string; reason?: string }>();

  const onAdd = (v: { email: string; reason?: string }) => {
    const doAdd = () =>
      add.mutate(v, {
        onSuccess: () => {
          message.success(t('spam.allowlist.added'));
          form.resetFields();
        },
        onError: (e) => message.error(e.message),
      });
    // The intake pipeline runs the Blocklist AFTER the allowlist relax and it always
    // wins — allowing a blocked sender silently does nothing, so say it up front.
    const blocked = blockRows.some((r) => r.email.toLowerCase() === v.email.trim().toLowerCase());
    if (blocked) {
      modal.confirm({ title: t('spam.conflictWithBlock', { email: v.email }), onOk: doAdd });
    } else {
      doAdd();
    }
  };

  const onRemove = (row: AllowlistEntry) => {
    modal.confirm({
      title: t('spam.allowlist.confirmRemove', { email: row.email }),
      okButtonProps: { danger: true },
      onOk: () =>
        remove
          .mutateAsync(row.id)
          .then(() => message.success(t('spam.allowlist.removed')))
          .catch((e: Error) => message.error(e.message)),
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Text type="secondary">{t('spam.allowlist.hint')}</Text>
      <Form form={form} layout="inline" onFinish={onAdd}>
        <Form.Item
          name="email"
          rules={[
            { required: true, message: t('spam.allowlist.emailRequired') },
            { type: 'email', message: t('spam.allowlist.emailInvalid') },
          ]}
        >
          <Input placeholder={t('spam.allowlist.emailPlaceholder')} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="reason">
          <Input placeholder={t('spam.allowlist.reasonPlaceholder')} style={{ width: 260 }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={add.isPending}>
          {t('spam.allowlist.addButton')}
        </Button>
      </Form>

      <Table<AllowlistEntry>
        rowKey="id"
        loading={isLoading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: t('spam.allowlist.colEmail'), dataIndex: 'email', width: 260 },
          {
            title: t('spam.allowlist.colReason'),
            dataIndex: 'reason',
            render: (r: string | null) => r ?? '—',
          },
          {
            title: t('spam.allowlist.colAllowedCount'),
            dataIndex: 'allowedCount',
            width: 130,
            render: (n: number) => <Tag color={n > 0 ? 'green' : 'default'}>{n}</Tag>,
          },
          {
            title: t('spam.allowlist.colAddedBy'),
            dataIndex: 'addedByEmail',
            render: (e: string | null) => e ?? '—',
          },
          {
            title: t('spam.allowlist.colDate'),
            dataIndex: 'createdAt',
            width: 170,
            render: (d: string) => fmtDateTime(d),
          },
          {
            title: '',
            width: 100,
            render: (_: unknown, row: AllowlistEntry) => (
              <Button size="small" danger onClick={() => onRemove(row)}>
                {t('spam.allowlist.remove')}
              </Button>
            ),
          },
        ]}
      />
    </Space>
  );
}

/** Mail-bomb threshold config + the "held mail" (suppressed) review: grouped by
 *  sender, each releasable ("Xử lý lại"), blockable, or ignorable (Story 7.2). */
function HeldMailTab() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: groups = [], isLoading } = useSuppressed();
  const reprocess = useReprocess();
  const ignore = useIgnoreSuppressed();
  const addBlock = useAddBlock();

  const onReprocess = (item: SuppressedItem) => {
    reprocess.mutate(item.id, {
      onSuccess: (res) => message.success(t(`spam.held.outcome.${res.outcome}`, { code: res.ticketCode ?? '' })),
      onError: (e) => message.error(e.message),
    });
  };

  const onIgnore = (item: SuppressedItem) => {
    // "Ignore" is audit-only on the BE (mark reviewed, row stays releasable) — no
    // confirm needed. Verified in admin-mailbomb.service.ts before assuming otherwise.
    ignore.mutate(item.id, {
      onSuccess: () => message.success(t('spam.held.ignored')),
      onError: (e) => message.error(e.message),
    });
  };

  const onBlock = (group: SuppressedGroup) => {
    modal.confirm({
      title: t('spam.held.confirmBlock', { sender: group.sender }),
      onOk: () =>
        addBlock
          .mutateAsync({ email: group.sender, reason: t('spam.held.blockReason') })
          .then(() => message.success(t('spam.blocklist.added')))
          .catch((e: Error) => message.error(e.message)),
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <ThresholdConfig />
      <Text type="secondary">{t('spam.held.hint')}</Text>
      {groups.length === 0 ? (
        <EmptyState art={<InboxZeroArt />} description={t('spam.held.empty')} />
      ) : (
        <Collapse
          items={groups.map((g) => ({
            key: g.sender,
            label: (
              <Space>
                <Text strong>{g.sender}</Text>
                <Tag color="orange">{t('spam.held.count', { n: g.count })}</Tag>
              </Space>
            ),
            extra: (
              <Button
                size="small"
                danger
                onClick={(e) => {
                  e.stopPropagation();
                  onBlock(g);
                }}
              >
                {t('spam.held.blockSender')}
              </Button>
            ),
            children: (
              <Table<SuppressedItem>
                rowKey="id"
                loading={isLoading}
                dataSource={g.items}
                pagination={false}
                size="small"
                columns={[
                  { title: t('spam.held.colSubject'), dataIndex: 'subject' },
                  {
                    title: t('spam.held.colReceived'),
                    dataIndex: 'receivedAt',
                    width: 180,
                    render: (d: string) => fmtDateTime(d),
                  },
                  {
                    title: '',
                    width: 220,
                    render: (_: unknown, item: SuppressedItem) => (
                      <Space>
                        <Button size="small" type="primary" onClick={() => onReprocess(item)}>
                          {t('spam.held.reprocess')}
                        </Button>
                        <Button size="small" onClick={() => onIgnore(item)}>
                          {t('spam.held.ignore')}
                        </Button>
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          }))}
        />
      )}
    </Space>
  );
}

function ThresholdConfig() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { data: cfg } = useMailBombConfig();
  const save = useSaveMailBombConfig();
  const [form] = Form.useForm<{ mailBombPerHour: number }>();

  useEffect(() => {
    if (cfg) form.setFieldsValue(cfg);
  }, [cfg, form]);

  return (
    <Card size="small" title={t('spam.held.thresholdTitle')}>
      <Form
        form={form}
        layout="inline"
        onFinish={(v) =>
          save.mutate(v, {
            onSuccess: () => message.success(t('spam.held.thresholdSaved')),
            onError: (e) => message.error(e.message),
          })
        }
      >
        <Form.Item
          name="mailBombPerHour"
          label={t('spam.held.thresholdLabel')}
          rules={[{ required: true }]}
        >
          <InputNumber min={1} max={1000} style={{ width: 120 }} addonAfter={t('spam.held.perHour')} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={save.isPending}>
          {t('common.save')}
        </Button>
      </Form>
    </Card>
  );
}

/** Junk rules CRUD (Story 7.3): keyword (subject+body, accent-insensitive) or sender
 *  glob (noreply@*, *@marketing.x.com). Matching new-ticket mail goes to the Junk tab. */
function JunkRulesTab() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: rows = [], isLoading } = useJunkRules();
  const add = useAddJunkRule();
  const remove = useRemoveJunkRule();
  const [form] = Form.useForm<{ kind: 'keyword' | 'sender'; pattern: string }>();

  const onAdd = (v: { kind: 'keyword' | 'sender'; pattern: string }) => {
    add.mutate(v, {
      onSuccess: () => {
        message.success(t('spam.junkRules.added'));
        form.resetFields();
      },
      onError: (e) => message.error(e.message),
    });
  };

  const onRemove = (row: JunkRule) => {
    modal.confirm({
      title: t('spam.junkRules.confirmRemove', { pattern: row.pattern }),
      okButtonProps: { danger: true },
      onOk: () =>
        remove
          .mutateAsync(row.id)
          .then(() => message.success(t('spam.junkRules.removed')))
          .catch((e: Error) => message.error(e.message)),
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Text type="secondary">{t('spam.junkRules.hint')}</Text>
      <Form form={form} layout="inline" initialValues={{ kind: 'keyword' }} onFinish={onAdd}>
        <Form.Item name="kind">
          <Select
            style={{ width: 140 }}
            options={[
              { value: 'keyword', label: t('spam.junkRules.kindKeyword') },
              { value: 'sender', label: t('spam.junkRules.kindSender') },
            ]}
          />
        </Form.Item>
        <Form.Item name="pattern" rules={[{ required: true, message: t('spam.junkRules.patternRequired') }]}>
          <Input placeholder={t('spam.junkRules.patternPlaceholder')} style={{ width: 300 }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={add.isPending}>
          {t('spam.junkRules.addButton')}
        </Button>
      </Form>

      <Table<JunkRule>
        rowKey="id"
        loading={isLoading}
        dataSource={rows}
        pagination={{ pageSize: 20, hideOnSinglePage: true, showTotal: (total) => t('common.totalRows', { total }) }}
        columns={[
          {
            title: t('spam.junkRules.colKind'),
            dataIndex: 'kind',
            width: 130,
            render: (k: string) => (
              <Tag color={k === 'keyword' ? 'blue' : 'purple'}>
                {k === 'keyword' ? t('spam.junkRules.kindKeyword') : t('spam.junkRules.kindSender')}
              </Tag>
            ),
          },
          { title: t('spam.junkRules.colPattern'), dataIndex: 'pattern' },
          {
            title: t('spam.junkRules.colCreatedAt'),
            dataIndex: 'createdAt',
            width: 170,
            render: (d: string) => fmtDateTime(d),
            sorter: (a: JunkRule, b: JunkRule) => a.createdAt.localeCompare(b.createdAt),
            defaultSortOrder: 'descend',
          },
          {
            title: '',
            width: 100,
            render: (_: unknown, row: JunkRule) => (
              <Button size="small" danger onClick={() => onRemove(row)}>
                {t('common.delete')}
              </Button>
            ),
          },
        ]}
      />
    </Space>
  );
}
