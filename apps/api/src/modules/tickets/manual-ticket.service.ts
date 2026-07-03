import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor, systemActor, type DbTx } from '../../infra/db/with-actor';
import {
  tickets,
  participants,
  projects,
  projectSettings,
  attachments,
  users,
  categories,
  userGroupMembership,
} from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { sniffType, mimeFor } from '../email-engine/magic-bytes';
import { storagePathFor, writeFile, statFile } from '../../infra/storage/fs-storage';
import { resolveImapConfig } from '../../infra/mail/connection-resolver';
import { classifyTicket } from '../routing/classify.service';
import { applyAutoTags } from '../routing/auto-tag.service';
import { autoAssign } from '../routing/auto-assign.service';
import { nextTicketCode } from './ticket-code';
import { sendOutboundMail } from './send-mail.usecase';
import type { SessionUser } from '../auth/session.service';

export interface ManualTicketInput {
  recipientEmail: string;
  subject: string;
  body: string;
  categoryId?: number;
  assigneeId?: string;
}
export interface ManualFile {
  fileName: string;
  content: Buffer;
}
export interface ManualTicketResult {
  ticketId: string;
  ticketCode: string;
}

/** Who may open a manual ticket (project Admin / TL / Member). SSA is the cross-project
 *  superuser and does not process a single project's tickets, so it's excluded here. */
const ALLOWED_CREATOR_ROLES = new Set<SessionUser['role']>(['admin', 'team_lead', 'member']);

function htmlFromText(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${esc.replace(/\n/g, '<br>')}</p>`;
}
/** Ticket code footer — the subject stays CLEAN (no `[#code]`) so the recipient's
 *  `Re:` replies and our later replies all share one Gmail conversation; matching
 *  back to the ticket runs on the References headers. */
function codeFooterText(ticketCode: string): string {
  return `\n\n-- \nMã yêu cầu / Ticket: ${ticketCode}`;
}
function codeFooterHtml(ticketCode: string): string {
  return `<div style="color:#8b93a3;font-size:12px;margin-top:16px">Mã yêu cầu / Ticket: ${ticketCode}</div>`;
}

@Injectable()
export class ManualTicketService {
  /**
   * Open a ticket by hand (an internal "need") and send the opening mail to the
   * recipient in ONE transaction. Unlike an emailed ticket it has no inbound message —
   * the creator's body IS the first OUTBOUND mail; the recipient's reply threads back
   * here via the References headers (FR7), with the ticket code in the body footer.
   *
   * Role model: project Admin / TL / Member may create + send this opening mail (the one
   * human-initiated outbound a creator is allowed). The ONGOING reply gate is untouched
   * (M1 / assertCanReplyTicket): only the assignee Member/TL replies after this.
   *
   * Runs under the SYSTEM actor (like email intake) so the INSERT clears the tickets RLS
   * check (the per-user policy only lets a member insert into their OWN groups, and
   * "Khác"/out-of-group would be rejected). The real creator is stamped on every audit row.
   */
  async create(
    user: SessionUser,
    input: ManualTicketInput,
    files: ManualFile[],
  ): Promise<ManualTicketResult> {
    if (!ALLOWED_CREATOR_ROLES.has(user.role)) {
      throw new ForbiddenException('Role cannot create tickets');
    }
    const projectId = user.projectId ?? 1;

    // Resolve the project's send mailbox BEFORE the write tx (it runs its own system reads).
    const [proj] = await withActor(systemActor, (tx) =>
      tx.select({ key: projects.key }).from(projects).where(eq(projects.id, projectId)),
    );
    if (!proj) throw new NotFoundException('Project not found');
    const mailbox = (await resolveImapConfig(proj.key)).mailbox;

    return withActor(systemActor, async (tx) => {
      // Category: an explicit pick wins; otherwise keyword-classify (→ "Khác" on no/multi match).
      // A client-supplied category must belong to THIS project and be enabled — the row
      // is inserted under systemActor (RLS bypassed), so without this a member could stamp
      // a ticket with another project's / a disabled / a sensitive category and bend its
      // group-based visibility. Mirror changeCategory's guard.
      if (input.categoryId !== undefined) {
        const [cat] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(
              eq(categories.id, input.categoryId),
              eq(categories.projectId, projectId),
              eq(categories.disabled, false),
            ),
          );
        if (!cat) throw new UnprocessableEntityException('Invalid category for this project');
      }
      const categoryId =
        input.categoryId ??
        (await classifyTicket(tx, projectId, input.subject, input.body)).categoryId;
      const ticketCode = await nextTicketCode(tx, projectId);
      const now = new Date();

      const [ticket] = await tx
        .insert(tickets)
        .values({
          projectId,
          ticketCode,
          subject: input.subject,
          requesterEmail: input.recipientEmail,
          mailbox,
          categoryId,
          status: 'open',
          externalSource: 'manual',
          createdAt: now,
          lastOpenedAt: now,
        })
        .returning({ id: tickets.id });
      const ticketId = ticket!.id;

      // Recipient is an active participant so the follow-up reply never flags it as a
      // stranger, and reply-defaults pre-fills To.
      await tx
        .insert(participants)
        .values({ ticketId, email: input.recipientEmail, status: 'active' })
        .onConflictDoNothing({ target: [participants.ticketId, participants.email] });

      // Store attachments (same magic-byte + per-project cap gates as the reply upload),
      // BEFORE the send so they can be linked to the outbound message.
      const attachmentIds = await this.storeFiles(tx, projectId, ticketId, files, user);

      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.created_manual',
        objectType: 'ticket',
        objectId: ticketId,
        newValue: {
          ticketCode,
          recipientEmail: input.recipientEmail,
          categoryId,
          subject: input.subject,
        },
      });

      // Auto-tag like an emailed ticket (attachment tag / priority keywords).
      await applyAutoTags(tx, {
        projectId,
        ticketId,
        subject: input.subject,
        body: input.body,
        signals: { hasStoredAttachment: attachmentIds.length > 0, isAutoReply: false },
      });

      // Send the opening mail NOW. No In-Reply-To/References — this STARTS the thread.
      await sendOutboundMail(tx, {
        projectId,
        ticketId,
        fromAddr: mailbox,
        to: [input.recipientEmail],
        subject: input.subject,
        bodyText: `${input.body}${codeFooterText(ticketCode)}`,
        bodyHtml: `${htmlFromText(input.body)}${codeFooterHtml(ticketCode)}`,
        attachmentIds,
      });
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.replied',
        objectType: 'ticket',
        objectId: ticketId,
        newValue: { via: 'manual_create', to: [input.recipientEmail] },
      });

      // An explicitly chosen assignee must be a real, ACTIVE handler in this project —
      // mirror assign()'s M11 guards so a disabled (or out-of-project, or Admin/SSA) user
      // can't be saddled with a ticket at creation time.
      if (input.assigneeId) {
        const [target] = await tx
          .select({ projectId: users.projectId, disabled: users.disabled, role: users.role })
          .from(users)
          .where(eq(users.id, input.assigneeId));
        if (!target || target.projectId !== projectId) {
          throw new UnprocessableEntityException('User not in this project');
        }
        if (target.disabled) throw new UnprocessableEntityException('User is disabled');
        if (target.role === 'admin' || target.role === 'ssa') {
          throw new UnprocessableEntityException('Admin/SSA do not handle tickets');
        }
      }
      // Assignment: an explicit assignee wins; a Member creator self-assigns ONLY if they
      // actually belong to the ticket's category group — otherwise self-assigning would
      // make them the handler of a group they're not in (CR-1). When they don't belong,
      // leave it pooled for the real group. Admin/TL never self-assign here.
      let memberSelfAssign = false;
      if (!input.assigneeId && user.role === 'member') {
        const [mem] = await tx
          .select({ userId: userGroupMembership.userId })
          .from(userGroupMembership)
          .where(
            and(
              eq(userGroupMembership.userId, user.id),
              eq(userGroupMembership.categoryId, categoryId),
            ),
          );
        memberSelfAssign = !!mem;
      }
      const owner = input.assigneeId ?? (memberSelfAssign ? user.id : null);
      if (owner) {
        await tx
          .update(tickets)
          .set({ assigneeId: owner, status: 'assigned', assignedAt: now })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.assigned',
          objectType: 'ticket',
          objectId: ticketId,
          newValue: { assigneeId: owner, via: 'manual_create' },
        });
      } else {
        await autoAssign(tx, { projectId, ticketId, ticketCode, categoryId });
      }

      return { ticketId, ticketCode };
    });
  }

  /** Validate + store each file under the system actor (mirrors UploadService's two
   *  gates: per-project soft cap, then a magic-byte whitelist on the real signature). */
  private async storeFiles(
    tx: DbTx,
    projectId: number,
    ticketId: string,
    files: ManualFile[],
    user: SessionUser,
  ): Promise<string[]> {
    if (files.length === 0) return [];
    const [settings] = await tx
      .select({
        allowed: projectSettings.allowedExtensions,
        capMb: projectSettings.attachmentCapMb,
      })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId));
    const allowed = new Set(settings?.allowed ?? []);
    const capBytes = (settings?.capMb ?? 50) * 1024 * 1024;

    const ids: string[] = [];
    for (const file of files) {
      if (file.content.length > capBytes) {
        throw new HttpException(
          `File exceeds the ${settings?.capMb ?? 50}MB limit`,
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
      }
      const sniffed = sniffType(file.content);
      if (!sniffed || !allowed.has(sniffed)) {
        throw new UnprocessableEntityException('File type not allowed');
      }
      const uuid = randomUUID();
      const relPath = storagePathFor(projectId, uuid, new Date());
      await writeFile(relPath, file.content); // BEFORE the row exists (2.5 protocol)

      const [row] = await tx
        .insert(attachments)
        .values({
          ticketId,
          fileName: file.fileName,
          mimeType: mimeFor(sniffed),
          size: file.content.length,
          storagePath: relPath,
          status: 'pending',
        })
        .returning({ id: attachments.id });

      const stat = await statFile(relPath);
      if (stat.exists && stat.size === file.content.length) {
        await tx.update(attachments).set({ status: 'stored' }).where(eq(attachments.id, row!.id));
      }

      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'attachment.uploaded',
        objectType: 'attachment',
        objectId: row!.id,
        newValue: { fileName: file.fileName, size: file.content.length, mimeType: mimeFor(sniffed) },
      });
      ids.push(row!.id);
    }
    return ids;
  }
}
