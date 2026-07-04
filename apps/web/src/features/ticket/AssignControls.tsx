import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal, Select, Space, Tag, Typography, App as AntApp } from 'antd';
import { hasCap, useMe } from '../../lib/auth';
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
  // Claim from "Khác" (đơn 5): a member in several groups must pick the destination.
  const [claimChoices, setClaimChoices] = useState<{ options: CategoryOption[]; over: boolean } | null>(null);

  const users = useAssignableUsers(ticket.id, assignOpen);
  const cats = useAssignCategories(ticket.id, catOpen);

  const inGroup = ticket.categoryId !== null && (me?.groups ?? []).includes(ticket.categoryId);
  const isAdmin = me?.role === 'admin' || me?.role === 'ssa';
  // Both gates also require the SSA-matrix capability (enforced by CapabilityGuard —
  // hiding here just avoids dead buttons that would 403).
  const canAssign =
    (isAdmin || (me?.role === 'team_lead' && inGroup)) && hasCap(me, 'ticket.assign_others');
  // Claim ("Nhận"/"Nhận thay") — đơn 5 v2: Admin/SSA pick up anywhere in the project;
  // Member and TL claim by GROUP MEMBERSHIP plus the shared "Khác" pool (where the
  // server forces a member to pick a real category). BE enforces (assertCanClaim → 403).
  const canClaim = (isAdmin || inGroup || !!ticket.categoryIsSystem) && hasCap(me, 'ticket.claim');
  const mine = ticket.assignee?.id === me?.user.id;
  // Claim-over rank rule (FR30): a plain Member may take over a peer (Member), but not
  // a ticket held by a Team Lead / Admin / SSA — outranking an assignment is a
  // coordinator action. TL/Admin/SSA may take over anyone. BE enforces this too
  // (assertCanClaimOver) — this only hides the dead button. Unknown holder role
  // (older payload) → allow the click; the server is the gate.
  const holderRole = ticket.assignee?.role;
  const canClaimOver =
    me?.role !== 'member' || holderRole === undefined || holderRole === 'member';
  // (Re)assignment is only valid on a NON-TERMINAL ticket — closed/resolved are out.
  // Pending (snoozed) is reassignable (CR-4): the handover keeps the status and the
  // follow-up date, exactly like claim-over. Mirrors the server guard.
  const active = ['open', 'assigned', 'in_progress', 'pending'].includes(ticket.status);

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
                onSuccess: (res) => {
                  if ('needsCategory' in res) setClaimChoices({ options: res.options, over: false });
                  else message.success(t('ticket.claimed'));
                },
                onError: () => message.warning(t('ticket.claimLost')),
              },
            )
          }
        >
          {t('ticket.claim')}
        </Button>
      )}

      {/* Assigned to someone else → claim-over (FR30). A Member can't pull a ticket
          from a Team Lead / Admin (canClaimOver) — only peer or coordinator take-over. */}
      {ticket.assignee && !mine && canClaim && canClaimOver && active && (
        <Button
          size="small"
          loading={claim.isPending}
          onClick={() =>
            modal.confirm({
              title: t('ticket.claimOverConfirm', { name: ticket.assignee!.name }),
              content: t('ticket.claimOverHint', { name: ticket.assignee!.name }),
              onOk: () =>
                claim.mutateAsync({ over: true }).then(
                  (res) => {
                    if ('needsCategory' in res) setClaimChoices({ options: res.options, over: true });
                    else message.success(t('ticket.claimed'));
                  },
                  () => message.warning(t('ticket.claimLost')),
                ),
            })
          }
        >
          {t('ticket.claimOver')}
        </Button>
      )}

      {/* Claim from "Khác" (đơn 5): the member must pick which group receives it. */}
      <Modal
        open={!!claimChoices}
        title={t('ticket.pickCategory')}
        footer={null}
        onCancel={() => setClaimChoices(null)}
      >
        <Select
          style={{ width: '100%' }}
          placeholder={t('ticket.pickCategory')}
          onChange={(v: number) => {
            const over = claimChoices?.over ?? false;
            setClaimChoices(null);
            claim.mutate(
              { over, categoryId: v },
              {
                onSuccess: (res) => {
                  if (!('needsCategory' in res)) message.success(t('ticket.claimed'));
                },
                onError: () => message.warning(t('ticket.claimLost')),
              },
            );
          }}
          options={(claimChoices?.options ?? []).map((c) => ({
            value: c.id,
            label: lang === 'en' ? c.nameEn : c.nameVi,
          }))}
        />
      </Modal>

      {canAssign && active && (
        <Button size="small" onClick={() => setAssignOpen(true)}>
          {t('ticket.assignTo')}
        </Button>
      )}
      {/* Đổi nhóm là thao tác điều phối → chỉ Admin/SSA (không cho Team Lead). */}
      {isAdmin && active && (
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
            label: `${u.name} (${u.email})`,
            awayFrom: u.awayFrom,
            awayTo: u.awayTo,
          }))}
          // P2: away users get the amber badge, not just a text suffix.
          optionRender={(opt) => (
            <span>
              {opt.data.label}
              {isAwayNow(opt.data.awayFrom, opt.data.awayTo) && (
                <AwayBadge awayFrom={opt.data.awayFrom} awayTo={opt.data.awayTo} />
              )}
            </span>
          )}
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
