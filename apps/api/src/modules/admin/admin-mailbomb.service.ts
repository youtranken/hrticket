import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { projectSettings, inboxMessages } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { actorForUser } from '../tickets/actor';
import { reprocessInboxMessage, type ReprocessOutcome } from '../intake/reprocess.usecase';
import { parseMail } from '../email-engine/parser';
import type { SessionUser } from '../auth/session.service';

export interface SuppressedGroup {
  sender: string;
  count: number;
  items: SuppressedItem[];
}
export interface SuppressedItem {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
}

/**
 * Admin mail-bomb surface (Story 7.2, FR101): the per-project threshold config +
 * the "held mail" (suppressed) review — list grouped by sender, reprocess ("Xử lý
 * lại"), or ignore. Scope resolved by the controller (Admin → own project, SSA →
 * X-Project); writes audited.
 */
@Injectable()
export class AdminMailBombService {
  async getConfig(user: SessionUser, projectId: number): Promise<{ mailBombPerHour: number }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .select({ perHour: projectSettings.mailBombPerHour })
        .from(projectSettings)
        .where(eq(projectSettings.projectId, projectId));
      return { mailBombPerHour: row?.perHour ?? 20 };
    });
  }

  async putConfig(
    user: SessionUser,
    projectId: number,
    mailBombPerHour: number,
  ): Promise<{ mailBombPerHour: number }> {
    if (!Number.isInteger(mailBombPerHour) || mailBombPerHour < 1) {
      throw new UnprocessableEntityException('mailBombPerHour must be >= 1');
    }
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [old] = await tx
        .select({ perHour: projectSettings.mailBombPerHour })
        .from(projectSettings)
        .where(eq(projectSettings.projectId, projectId));
      await tx
        .update(projectSettings)
        .set({ mailBombPerHour })
        .where(eq(projectSettings.projectId, projectId));
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'mail_bomb_config.updated',
        objectType: 'project_settings',
        objectId: String(projectId),
        oldValue: { mailBombPerHour: old?.perHour ?? null },
        newValue: { mailBombPerHour },
      });
      return { mailBombPerHour };
    });
  }

  /** Suppressed mails for the project, grouped by sender (newest first). The sender +
   *  subject are parsed from the raw mail (no separate column). */
  async listSuppressed(user: SessionUser, projectId: number): Promise<SuppressedGroup[]> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({ id: inboxMessages.id, raw: inboxMessages.raw, createdAt: inboxMessages.createdAt })
        .from(inboxMessages)
        .where(
          and(eq(inboxMessages.projectId, projectId), eq(inboxMessages.status, 'suppressed')),
        )
        .orderBy(desc(inboxMessages.createdAt));

      const groups = new Map<string, SuppressedItem[]>();
      for (const r of rows) {
        const parsed = await parseMail(r.raw);
        const from = parsed.from?.address ?? 'unknown@unknown';
        const item: SuppressedItem = {
          id: r.id,
          subject: parsed.subject,
          from,
          receivedAt: r.createdAt.toISOString(),
        };
        const arr = groups.get(from) ?? [];
        arr.push(item);
        groups.set(from, arr);
      }
      return [...groups.entries()]
        .map(([sender, items]) => ({ sender, count: items.length, items }))
        .sort((a, b) => b.count - a.count);
    });
  }

  /** Release one held mail back through the pipeline from the junk stage (M8). */
  async reprocess(
    user: SessionUser,
    projectId: number,
    inboxMessageId: string,
  ): Promise<{ outcome: ReprocessOutcome; ticketCode?: string }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .select({ id: inboxMessages.id, status: inboxMessages.status })
        .from(inboxMessages)
        .where(and(eq(inboxMessages.id, inboxMessageId), eq(inboxMessages.projectId, projectId)));
      if (!row || row.status !== 'suppressed') throw new NotFoundException('Not a held mail');
      const res = await reprocessInboxMessage(tx, inboxMessageId);
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'mail_bomb.released',
        objectType: 'inbox_message',
        objectId: inboxMessageId,
        newValue: { outcome: res.outcome, ticketId: res.ticketId },
      });
      return { outcome: res.outcome, ticketCode: res.ticketCode };
    });
  }

  /** "Bỏ qua": keep the mail suppressed (still has a trace), just acknowledge it was
   *  reviewed — audit only, no state change (NFR8: the row stays listed/releasable). */
  async ignore(user: SessionUser, projectId: number, inboxMessageId: string): Promise<{ ok: true }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .select({ id: inboxMessages.id, status: inboxMessages.status })
        .from(inboxMessages)
        .where(and(eq(inboxMessages.id, inboxMessageId), eq(inboxMessages.projectId, projectId)));
      if (!row || row.status !== 'suppressed') throw new NotFoundException('Not a held mail');
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'mail_bomb.ignored',
        objectType: 'inbox_message',
        objectId: inboxMessageId,
      });
      return { ok: true };
    });
  }
}
