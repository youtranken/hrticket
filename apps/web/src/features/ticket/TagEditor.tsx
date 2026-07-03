import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, Select, Button, Space, Popover } from 'antd';
import { useTicketTags, useToggleTag } from '../../lib/tickets';

/** Inline tag chips with add/remove (Story 4.1 — manual tagging). Only a handler
 *  (assignee / TL / Admin, on a non-closed ticket — `canEdit`) may change tags, and
 *  only MANUAL tags can be removed; system tags (auto/priority) are read-only. */
export function TagEditor({
  ticketId,
  tags,
  canEdit = false,
}: {
  ticketId: string;
  tags: { name: string; color: string | null }[];
  canEdit?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const available = useTicketTags(ticketId, true); // eager: chip-remove needs the ids
  const toggle = useToggleTag(ticketId);

  const picker = (
    <Select
      style={{ minWidth: 220 }}
      showSearch
      placeholder={t('ticket.addTag')}
      loading={available.isLoading}
      optionFilterProp="label"
      value={null}
      onChange={(tagId: number) => toggle.mutate({ tagId, on: true })}
      options={(available.data ?? [])
        .filter((tg) => !tg.applied)
        .map((tg) => ({ value: tg.id, label: tg.name }))}
    />
  );

  return (
    <Space size={4} wrap>
      {tags.map((tg) => {
        const info = available.data?.find((a) => a.name === tg.name);
        // Removable only by a handler AND only manual tags (system auto/priority stay).
        const removable = canEdit && info !== undefined && info.kind === 'manual';
        return (
          <Tag
            key={tg.name}
            color={tg.color ?? 'default'}
            closable={removable}
            onClose={(e) => {
              e.preventDefault();
              if (removable) toggle.mutate({ tagId: info!.id, on: false });
            }}
          >
            {tg.name}
          </Tag>
        );
      })}
      {canEdit && (
        <Popover trigger="click" open={open} onOpenChange={setOpen} content={picker}>
          <Button size="small" type="dashed">
            + {t('ticket.addTag')}
          </Button>
        </Popover>
      )}
    </Space>
  );
}
