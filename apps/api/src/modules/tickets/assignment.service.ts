import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { withActor, type DbTx } from '../../infra/db/with-actor';
import {
  tickets,
  users,
  categories,
  userGroupMembership,
} from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { emitNotification } from '../notifications/emit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';

interface TicketRow {
  id: string;
  projectId: number;
  categoryId: number | null;
  assigneeId: string | null;
  status: string;
  ticketCode: string;
}

export interface CategoryOption {
  id: number;
  nameVi: string;
  nameEn: string;
}

export type AssignResult =
  | { assigneeId: string; categoryId: number | null }
  | { needsCategory: true; options: CategoryOption[] };

async function notify(tx: DbTx, userId: string, type: string, payload: object): Promise<void> {
  await emitNotification(tx, { actorId: userId, type, payload });
}

@Injectable()
export class AssignmentService {
  private async loadTicket(tx: DbTx, ticketId: string): Promise<TicketRow> {
    const [t] = await tx
      .select({
        id: tickets.id,
        projectId: tickets.projectId,
        categoryId: tickets.categoryId,
        assigneeId: tickets.assigneeId,
        status: tickets.status,
        ticketCode: tickets.ticketCode,
      })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    if (!t) throw new NotFoundException('Ticket not found'); // RLS-invisible → 404, no leak
    return t;
  }

  /**
   * Claim a ticket to myself (Story 4.4, FR29/FR30 — reworked by đơn 5). Pool claim
   * and claim-over both use an atomic conditional UPDATE whose WHERE pins the
   * expected prior state — a row-count of 1 wins, 0 means someone beat me → 409.
   * Admin/SSA/TL may pick up ANY pool of their project (incl. "Khác"); a Member needs
   * their group, and claiming from "Khác" must land in a REAL category — one group →
   * auto, several → needsCategory (the caller re-sends with categoryId).
   */
  async claim(
    user: SessionUser,
    ticketId: string,
    opts: { over?: boolean; categoryId?: number } = {},
  ): Promise<
    | { assigneeId: string; from: string | null }
    | { needsCategory: true; options: CategoryOption[] }
  > {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const t = await this.loadTicket(tx, ticketId);
      const [cat] = await tx
        .select({ isSystem: categories.isSystem })
        .from(categories)
        .where(eq(categories.id, t.categoryId ?? -1));
      const isOther = cat?.isSystem ?? false; // "Khác" is the only system category
      this.assertCanClaim(user, (actor.kind === 'user' ? actor.groups : []), t, isOther);
      // Cross-post no longer locks: both projects may pick up their side of a shared mail.
      // Never claim a terminal ticket (P2): closed/resolved are out of the worklist —
      // claim-over especially must not resurrect them past the state machine.
      if (t.status === 'closed' || t.status === 'resolved') {
        throw new ConflictException('Ticket already closed');
      }

      if (t.assigneeId === user.id) {
        return { assigneeId: user.id, from: user.id }; // already mine — idempotent
      }

      // Resolve the "Khác" re-classification BEFORE the atomic claim, so we never hold
      // a ticket we can't finish categorising (đơn 5: a Member must not leave it "Khác").
      let reclassifyTo: number | null = null;
      if (isOther) {
        const myGroups = await tx
          .select({ id: categories.id, nameVi: categories.nameVi, nameEn: categories.nameEn })
          .from(userGroupMembership)
          .innerJoin(categories, eq(categories.id, userGroupMembership.categoryId))
          .where(
            and(
              eq(userGroupMembership.userId, user.id),
              eq(categories.projectId, t.projectId),
              eq(categories.isSystem, false),
              eq(categories.disabled, false),
            ),
          );
        if (opts.categoryId) {
          if (!myGroups.some((g) => g.id === opts.categoryId)) {
            throw new UnprocessableEntityException('Not a member of the chosen category');
          }
          reclassifyTo = opts.categoryId;
        } else if (myGroups.length === 1) {
          reclassifyTo = myGroups[0]!.id;
        } else if (user.role === 'member') {
          // A member may not keep it "Khác": several groups → make them choose; none →
          // they have nowhere to put it, so they can't take it out of the shared pool.
          if (myGroups.length === 0) {
            throw new UnprocessableEntityException('No category group to receive this ticket');
          }
          return { needsCategory: true as const, options: myGroups };
        }
        // TL/Admin/SSA with 0 or many groups → may keep "Khác" (only members are forced).
      }

      if (opts.over && t.assigneeId !== null) {
        // Claim-over (FR30) — an EXPLICIT take-from-holder, atomically pinned to the
        // current holder so two over-claims can't both win. Mirror manual assign:
        // only open→assigned, otherwise PRESERVE the status (never force an illegal
        // pending/in_progress→assigned transition, which would also orphan snooze_until).
        // Pin the status we read too, so a concurrent close/transition makes this a
        // 0-row → 409 (closes the TOCTOU that could otherwise resurrect a closed ticket).
        const [holder] = await tx
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, t.assigneeId));
        // Fail CLOSED: if the holder can't be resolved, deny rather than defaulting to
        // 'member' (which would let a member take over an unknown holder).
        if (!holder) throw new ForbiddenException('Current holder not found');
        this.assertCanClaimOver(user, holder.role);
        const prev = t.assigneeId;
        const nextStatus = t.status === 'open' ? 'assigned' : t.status;
        const won = await tx
          .update(tickets)
          .set({ assigneeId: user.id, status: nextStatus as 'assigned', assignedAt: new Date() })
          .where(
            and(eq(tickets.id, ticketId), eq(tickets.assigneeId, prev), eq(tickets.status, t.status as 'open')),
          )
          .returning({ id: tickets.id });
        if (won.length === 0) throw new ConflictException('Ticket already claimed');
        await notify(tx, prev, 'ticket_reassigned', {
          ticketId,
          ticketCode: t.ticketCode,
          by: user.email,
        });
      } else {
        // Pool claim (default, FR29): win an Open + unassigned ticket. The conditional
        // WHERE is the whole race guard — a serialized loser sees 0 rows → 409, NOT a
        // silent take-over (AC1). A ticket already held by someone else also 0-rows
        // here: the caller must opt into `over` to take it.
        const won = await tx
          .update(tickets)
          .set({ assigneeId: user.id, status: 'assigned', assignedAt: new Date() })
          .where(and(eq(tickets.id, ticketId), isNull(tickets.assigneeId), eq(tickets.status, 'open')))
          .returning({ id: tickets.id });
        if (won.length === 0) throw new ConflictException('Ticket already claimed');
      }

      // Apply the "Khác" re-classification decided above (FR35 / đơn 5).
      let newCategoryId = t.categoryId;
      if (reclassifyTo !== null) {
        newCategoryId = reclassifyTo;
        await tx.update(tickets).set({ categoryId: newCategoryId }).where(eq(tickets.id, ticketId));
      }

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.claimed',
        objectType: 'ticket',
        objectId: ticketId,
        oldValue: { assigneeId: t.assigneeId, categoryId: t.categoryId },
        newValue: { assigneeId: user.id, categoryId: newCategoryId },
      });
      return { assigneeId: user.id, from: t.assigneeId };
    });
  }

  /**
   * Manual assign / reassign (Story 4.5, FR34). Team Lead (own group), Admin (own
   * project), or SSA only — Member is 403 (they claim-to-self). Ignores the target's
   * availability (unlike auto-assign) and never edits it. A disabled target is 422.
   * When the ticket is "Khác", assigning re-classifies it into the assignee's group
   * (FR35): one group → auto; many → the caller must pick (needsCategory); none → stays.
   */
  async assign(
    user: SessionUser,
    ticketId: string,
    input: { assigneeId: string; categoryId?: number },
  ): Promise<AssignResult> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      // Serialize concurrent manual assigns on the same ticket (P1): lock the row
      // before reading so two TL/Admin assigns can't lost-update each other.
      await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId)).for('update');
      const t = await this.loadTicket(tx, ticketId);
      this.assertCanAssign(user, (actor.kind === 'user' ? actor.groups : []), t);
      // A lifecycle write must respect the state machine (P1): never (re)assign a
      // ticket that's out of active handling — closed/resolved are terminal. A
      // PENDING (snoozed) ticket IS reassignable (CR-4 deep-dive 3/7/2026): the
      // status + snooze_until are preserved below exactly like claim-over does —
      // blocking it only stranded snoozed tickets on someone who left/is away,
      // while the same handover was already possible via claim-over.
      if (t.status === 'closed' || t.status === 'resolved') {
        throw new ConflictException('INVALID_TRANSITION');
      }

      const [target] = await tx
        .select({ id: users.id, projectId: users.projectId, disabled: users.disabled, role: users.role })
        .from(users)
        .where(eq(users.id, input.assigneeId));
      if (!target || target.projectId !== t.projectId) {
        throw new UnprocessableEntityException('User not in this project');
      }
      if (target.disabled) throw new UnprocessableEntityException('User is disabled'); // M11
      // A ticket is handled by its assignee (claim + reply). Admin/SSA coordinate and
      // never process — assigning to them would dead-end (they can't reply). Reject it
      // here too, not just in the picker, so the API can't be driven past the UX gate.
      if (target.role === 'admin' || target.role === 'ssa') {
        throw new UnprocessableEntityException('Cannot assign to an Admin/SSA — they coordinate, not handle');
      }

      // Re-classify "Khác" by the assignee's groups (FR35).
      let newCategoryId = t.categoryId;
      const [cat] = await tx
        .select({ isSystem: categories.isSystem })
        .from(categories)
        .where(eq(categories.id, t.categoryId ?? -1));
      if (cat?.isSystem) {
        const groups = await tx
          .select({ id: categories.id, nameVi: categories.nameVi, nameEn: categories.nameEn })
          .from(userGroupMembership)
          .innerJoin(categories, eq(categories.id, userGroupMembership.categoryId))
          .where(
            and(
              eq(userGroupMembership.userId, target.id),
              eq(categories.projectId, t.projectId),
              eq(categories.isSystem, false),
              eq(categories.disabled, false),
            ),
          );
        if (input.categoryId) {
          if (!groups.some((g) => g.id === input.categoryId)) {
            throw new UnprocessableEntityException('Assignee is not in the chosen category');
          }
          newCategoryId = input.categoryId;
        } else if (groups.length === 1) {
          newCategoryId = groups[0]!.id;
        } else if (groups.length > 1) {
          // Ambiguous → make the caller choose (D.A6: category is a step AFTER claim).
          return { needsCategory: true as const, options: groups };
        }
        // groups.length === 0 → keep "Khác".
      }

      const prev = t.assigneeId;
      // Đơn 5: a manual assignment starts the work — the ticket goes straight to
      // In Progress (open→assigned→in_progress is legal stepwise), not "đã giao".
      // pending / in_progress keep their status (pending also keeps snooze_until —
      // the new assignee inherits the follow-up date).
      const nextStatus = t.status === 'open' || t.status === 'assigned' ? 'in_progress' : t.status;
      await tx
        .update(tickets)
        .set({
          assigneeId: target.id,
          categoryId: newCategoryId,
          status: nextStatus as 'in_progress',
          assignedAt: new Date(),
        })
        .where(eq(tickets.id, ticketId));

      if (target.id !== prev) {
        await notify(tx, target.id, 'ticket_assigned', {
          ticketId,
          ticketCode: t.ticketCode,
          by: user.email,
        });
        if (prev) {
          await notify(tx, prev, 'ticket_reassigned', {
            ticketId,
            ticketCode: t.ticketCode,
            by: user.email,
          });
        }
      }

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.assigned',
        objectType: 'ticket',
        objectId: ticketId,
        oldValue: { assigneeId: prev, categoryId: t.categoryId },
        newValue: { assigneeId: target.id, categoryId: newCategoryId },
      });
      return { assigneeId: target.id, categoryId: newCategoryId };
    });
  }

  /** Standalone "change category" (Story 4.5 tail, FR35). Same authz as assign. */
  async changeCategory(
    user: SessionUser,
    ticketId: string,
    categoryId: number,
  ): Promise<{ categoryId: number }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      // Lock the row so a concurrent assign/category-change can't lost-update it (P1).
      await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId)).for('update');
      const t = await this.loadTicket(tx, ticketId);
      this.assertCanAssign(user, (actor.kind === 'user' ? actor.groups : []), t);

      const [target] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(
            eq(categories.id, categoryId),
            eq(categories.projectId, t.projectId),
            eq(categories.disabled, false),
          ),
        );
      if (!target) throw new UnprocessableEntityException('Category not found in this project');

      await tx.update(tickets).set({ categoryId }).where(eq(tickets.id, ticketId));
      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.category_changed',
        objectType: 'ticket',
        objectId: ticketId,
        oldValue: { categoryId: t.categoryId },
        newValue: { categoryId },
      });
      return { categoryId };
    });
  }

  /**
   * Candidate assignees for the "Gán cho…" modal (Story 4.5). For a real category,
   * the group's members; for "Khác" (no group), everyone in the project — assigning
   * will re-classify by the chosen person's groups. Disabled users are excluded so
   * they can't be picked (M11). Away users ARE included (manual assign ignores it).
   */
  async assignableUsers(
    user: SessionUser,
    ticketId: string,
  ): Promise<Array<{ id: string; name: string; email: string; awayFrom: string | null; awayTo: string | null }>> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const t = await this.loadTicket(tx, ticketId);
      this.assertCanAssign(user, (actor.kind === 'user' ? actor.groups : []), t);

      const [cat] = await tx
        .select({ isSystem: categories.isSystem })
        .from(categories)
        .where(eq(categories.id, t.categoryId ?? -1));

      const cols = {
        id: users.id,
        name: users.name,
        email: users.email,
        awayFrom: users.awayFrom,
        awayTo: users.awayTo,
      };
      // Never offer the CURRENT assignee — "Gán cho" is for (re)assigning to someone else.
      const notCurrent = t.assigneeId ? ne(users.id, t.assigneeId) : undefined;
      // Only HANDLERS are assignable: Member + Team Lead. Admin/SSA coordinate (assign +
      // oversee), they don't process tickets (can't reply) — so they are never a target.
      const handlersOnly = inArray(users.role, ['member', 'team_lead']);
      const allProjectUsers = () =>
        tx
          .select(cols)
          .from(users)
          .where(and(eq(users.projectId, t.projectId), eq(users.disabled, false), handlersOnly, notCurrent));

      // "Khác"/no category → everyone (assigning re-classifies by the assignee's groups).
      if (!t.categoryId || cat?.isSystem) return allProjectUsers();

      const members = await tx
        .select(cols)
        .from(userGroupMembership)
        .innerJoin(users, eq(users.id, userGroupMembership.userId))
        .where(
          and(eq(userGroupMembership.categoryId, t.categoryId), eq(users.disabled, false), handlersOnly, notCurrent),
        );
      // A real category with NO designated handlers would otherwise dead-end the picker
      // (empty list — the coordinator can't assign the ticket to anyone). Fall back to all
      // project users so it stays assignable; the proper fix is to add members to the
      // category group in /admin/groups.
      return members.length > 0 ? members : allProjectUsers();
    });
  }

  /** Active categories of the ticket's project, for the "Đổi category" picker (4.5). */
  async categoriesForAssign(
    user: SessionUser,
    ticketId: string,
  ): Promise<Array<{ id: number; nameVi: string; nameEn: string; isSystem: boolean }>> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const t = await this.loadTicket(tx, ticketId);
      this.assertCanAssign(user, actor.kind === 'user' ? actor.groups : [], t);
      return tx
        .select({
          id: categories.id,
          nameVi: categories.nameVi,
          nameEn: categories.nameEn,
          isSystem: categories.isSystem,
        })
        .from(categories)
        .where(and(eq(categories.projectId, t.projectId), eq(categories.disabled, false)));
    });
  }

  /**
   * Claim-over rank rule (FR30): a Member may take a pool ticket or take OVER a peer
   * (another Member) in their group, but may NOT pull a ticket out from under a Team
   * Lead — outranking an assignment is a coordinator action. Only a TL reaches this with
   * `user.role !== 'member'` (Admin/SSA are already rejected by assertInGroup — they
   * distribute, not claim), and a TL may take over anyone in their group. Manual
   * (re)assign in the other direction — TL handing a ticket to a Member — goes through
   * `assign()`, not here.
   */
  private assertCanClaimOver(user: SessionUser, holderRole: string): void {
    if (user.role !== 'member') return; // TL (the only non-member that reaches here) may take over
    if (holderRole === 'member') return; // member ↔ member peer take-over is allowed
    throw new ForbiddenException('A member cannot take over a ticket held by a team lead or admin');
  }

  /**
   * Who may claim a ticket (đơn 5, v2): Admin/SSA may pick up anywhere in their
   * project. Member AND Team Lead claim BY GROUP MEMBERSHIP — the pools they were
   * added to in /admin/groups — plus the shared "Khác" pool (where claim() then
   * forces a member to pick a real category). RLS already hides out-of-group
   * tickets from TL/member (→ 404); this is the service-side defence in depth.
   */
  private assertCanClaim(user: SessionUser, groups: number[], t: TicketRow, isOther: boolean): void {
    if (user.role === 'admin' || user.role === 'ssa') return;
    if (t.assigneeId === user.id) return;
    if (t.categoryId !== null && groups.includes(t.categoryId)) return;
    if (isOther) return; // the shared "Khác" pool — a member must pick a category in claim()
    throw new ForbiddenException('Not a member of this ticket group');
  }

  /** Who may assign others: TL of the ticket's group, Admin (project), SSA. */
  private assertCanAssign(user: SessionUser, groups: number[], t: TicketRow): void {
    if (user.role === 'admin' || user.role === 'ssa') return; // RLS already scoped the project
    if (user.role === 'team_lead' && t.categoryId !== null && groups.includes(t.categoryId)) return;
    throw new ForbiddenException('Not allowed to assign this ticket');
  }
}
