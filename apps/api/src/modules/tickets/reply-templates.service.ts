import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { replyTemplates } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { actorForUser } from './actor';
import type { SessionUser } from '../auth/session.service';

export interface ReplyTemplate {
  id: number;
  title: string;
  body: string;
  updatedAt: string;
}

/**
 * Agent canned-reply templates, per project. Everyone may LIST/USE them (the composer
 * picker); only SSA/Admin/TL may mutate (gated in the controller). Bodies may carry
 * {{ticketCode}}/{{requesterName}}/{{agentName}} placeholders, substituted client-side
 * on insert — the server stores them verbatim.
 */
@Injectable()
export class ReplyTemplatesService {
  async list(user: SessionUser, projectId: number): Promise<ReplyTemplate[]> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          id: replyTemplates.id,
          title: replyTemplates.title,
          body: replyTemplates.body,
          updatedAt: replyTemplates.updatedAt,
        })
        .from(replyTemplates)
        .where(eq(replyTemplates.projectId, projectId))
        .orderBy(asc(replyTemplates.title));
      return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, updatedAt: r.updatedAt.toISOString() }));
    });
  }

  async create(
    user: SessionUser,
    projectId: number,
    input: { title: string; body: string },
  ): Promise<ReplyTemplate> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .insert(replyTemplates)
        .values({ projectId, title: input.title, body: input.body, createdBy: user.id })
        .returning();
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'reply_template.created',
        objectType: 'reply_template',
        objectId: String(row!.id),
        newValue: { title: input.title },
      });
      return { id: row!.id, title: row!.title, body: row!.body, updatedAt: row!.updatedAt.toISOString() };
    });
  }

  async update(
    user: SessionUser,
    projectId: number,
    id: number,
    input: { title: string; body: string },
  ): Promise<ReplyTemplate> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .update(replyTemplates)
        .set({ title: input.title, body: input.body, updatedAt: new Date() })
        .where(and(eq(replyTemplates.id, id), eq(replyTemplates.projectId, projectId)))
        .returning();
      if (!row) throw new NotFoundException('Template not found');
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'reply_template.updated',
        objectType: 'reply_template',
        objectId: String(id),
        newValue: { title: input.title },
      });
      return { id: row.id, title: row.title, body: row.body, updatedAt: row.updatedAt.toISOString() };
    });
  }

  async remove(user: SessionUser, projectId: number, id: number): Promise<{ ok: true }> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [old] = await tx
        .select({ title: replyTemplates.title })
        .from(replyTemplates)
        .where(and(eq(replyTemplates.id, id), eq(replyTemplates.projectId, projectId)));
      if (!old) throw new NotFoundException('Template not found');
      await tx
        .delete(replyTemplates)
        .where(and(eq(replyTemplates.id, id), eq(replyTemplates.projectId, projectId)));
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'reply_template.deleted',
        objectType: 'reply_template',
        objectId: String(id),
        oldValue: { title: old.title },
      });
      return { ok: true as const };
    });
  }
}
