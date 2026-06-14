import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, Select, Button, Space, Popover } from 'antd';
import { useTicketTags, useToggleTag } from '../../lib/tickets';

/** Inline tag chips with add/remove (Story 4.1 — manual tagging). Auto tags can be
 *  removed here too; classification re-adds signal tags on the next message only. */
export function TagEditor({ ticketId, tags }: { ticketId: string; tags: { name: string; color: string | null }[] }) {
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
        const id = available.data?.find((a) => a.name === tg.name)?.id;
        return (
          <Tag
            key={tg.name}
            color={tg.color ?? 'default'}
            closable={id !== undefined}
            onClose={(e) => {
              e.preventDefault();
              if (id !== undefined) toggle.mutate({ tagId: id, on: false });
            }}
          >
            {tg.name}
          </Tag>
        );
      })}
      <Popover trigger="click" open={open} onOpenChange={setOpen} content={picker}>
        <Button size="small" type="dashed">
          + {t('ticket.addTag')}
        </Button>
      </Popover>
    </Space>
  );
}
