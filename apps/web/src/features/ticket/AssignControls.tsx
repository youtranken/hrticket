import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal, Select, Space, Tag, Typography, App as AntApp } from 'antd';
import { useMe } from '../../lib/auth';
import {
  useClaim,
  useAssign,
  useAssignableUsers,
  useAssignCategories,
  useChangeCategory,
  isAwayNow,
  type TicketDetail,
  type CategoryOption,
} from '../../lib/tickets';
import { AwayBadge } from '../../components/AwayBadge';
import i18n from '../../i18n';

const { Text } = Typography;

/** Assignment block on the ticket detail: current assignee, claim / claim-over,
 *  "Gán cho…" (manual assign + re-classify), and "Đổi category" (Story 4.4 + 4.5). */
export function AssignControls({ ticket }: { ticket: TicketDetail['ticket'] }) {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const { data: me } = useMe();
  const lang = i18n.language === 'en' ? 'en' : 'vi';
  const claim = useClaim(ticket.id);
  const assign = useAssign(ticket.id);
  const changeCategory = useChangeCategory(ticket.id);

  const [assignOpen, setAssignOpen] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [pickUser, setPickUser] = useState<string | undefined>();
  const [pickCategory, setPickCategory] = useState<number | undefined>();
  const [categoryChoices, setCategoryChoices] = useState<CategoryOption[] | null>(null);

  const users = useAssignableUsers(ticket.id, assignOpen);
  const cats = useAssignCategories(ticket.id, catOpen);

  const inGroup = ticket.categoryId !== null && (me?.groups ?? []).includes(ticket.categoryId);
  const isAdmin = me?.role === 'admin' || me?.role === 'ssa';
  const canAssign = isAdmin || (me?.role === 'team_lead' && inGroup);
  const canClaim = isAdmin || inGroup; // member/TL in group, or admin/ssa
  const mine = ticket.assignee?.id === me?.user.id;

  const submitAssign = (categoryId?: number) => {
    if (!pickUser) return;
    assign.mutate(
      { assigneeId: pickUser, categoryId },
      {
        onSuccess: (res) => {
          if ('needsCategory' in res) {
            setCategoryChoices(res.options); // re-classify ambiguity → pick a category
            return;
          }
          message.success(t('ticket.assigned'));
          setAssignOpen(false);
          setCategoryChoices(null);
          setPickUser(undefined);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  return (
    <Space wrap>
      <Text type="secondary">{t('ticket.assignee')}:</Text>
      {ticket.assignee ? (
        <span>
          <Text strong>{ticket.assignee.name}</Text>
          <AwayBadge awayFrom={ticket.assignee.awayFrom} awayTo={ticket.assignee.awayTo} />
        </span>
      ) : (
        <Tag>{t('ticket.pool')}</Tag>
      )}

      {/* Pool ticket → claim it. */}
      {!ticket.assignee && canClaim && (
        <Button
          size="small"
          type="primary"
          loading={claim.isPending}
          onClick={() =>
            claim.mutate(
              {},
              {
                onSuccess: () => message.success(t('ticket.claimed')),
                onError: () => message.warning(t('ticket.claimLost')),
              },
            )
          }
        >
          {t('ticket.claim')}
        </Button>
      )}

      {/* Assigned to someone else → claim-over (FR30). */}
      {ticket.assignee && !mine && canClaim && (
        <Button
          size="small"
          loading={claim.isPending}
          onClick={() =>
            modal.confirm({
              title: t('ticket.claimOverConfirm', { name: ticket.assignee!.name }),
              onOk: () =>
                claim.mutateAsync({ over: true }).then(
                  () => message.success(t('ticket.claimed')),
                  () => message.warning(t('ticket.claimLost')),
                ),
            })
          }
        >
          {t('ticket.claimOver')}
        </Button>
      )}

      {canAssign && (
        <Button size="small" onClick={() => setAssignOpen(true)}>
          {t('ticket.assignTo')}
        </Button>
      )}
      {canAssign && (
        <Button size="small" onClick={() => setCatOpen(true)}>
          {t('ticket.changeCategory')}
        </Button>
      )}

      {/* Assign modal: pick a user (away users shown but selectable). */}
      <Modal
        open={assignOpen}
        title={t('ticket.assignTo')}
        okButtonProps={{ disabled: !pickUser, loading: assign.isPending }}
        onOk={() => submitAssign()}
        onCancel={() => {
          setAssignOpen(false);
          setCategoryChoices(null);
        }}
      >
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder={t('ticket.pickAssignee')}
          loading={users.isLoading}
          value={pickUser}
          optionFilterProp="label"
          onChange={setPickUser}
          options={(users.data ?? []).map((u) => ({
            value: u.id,
            label: `${u.name} (${u.email})${isAwayNow(u.awayFrom, u.awayTo) ? ' • ' + t('availability.away') : ''}`,
          }))}
        />
        {/* Re-classify: the chosen user is in several groups → pick the category. */}
        {categoryChoices && (
          <div style={{ marginTop: 12 }}>
            <Text>{t('ticket.pickCategory')}</Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              value={pickCategory}
              onChange={(v) => {
                setPickCategory(v);
                submitAssign(v);
              }}
              options={categoryChoices.map((c) => ({ value: c.id, label: lang === 'en' ? c.nameEn : c.nameVi }))}
            />
          </div>
        )}
      </Modal>

      {/* Change-category modal. */}
      <Modal
        open={catOpen}
        title={t('ticket.changeCategory')}
        okButtonProps={{ disabled: !pickCategory, loading: changeCategory.isPending }}
        onOk={() =>
          pickCategory &&
          changeCategory.mutate(
            { categoryId: pickCategory },
            {
              onSuccess: () => {
                message.success(t('ticket.categoryChanged'));
                setCatOpen(false);
              },
              onError: (e) => message.error(e.message),
            },
          )
        }
        onCancel={() => setCatOpen(false)}
      >
        <Select
          style={{ width: '100%' }}
          placeholder={t('ticket.pickCategory')}
          loading={cats.isLoading}
          value={pickCategory}
          onChange={setPickCategory}
          options={(cats.data ?? []).map((c) => ({ value: c.id, label: lang === 'en' ? c.nameEn : c.nameVi }))}
        />
      </Modal>
    </Space>
  );
}
