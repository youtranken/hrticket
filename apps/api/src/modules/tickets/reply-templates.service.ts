import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { replyTemplates, categories } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { actorForUser } from './actor';
import type { SessionUser } from '../auth/session.service';

export interface ReplyTemplate {
  id: number;
  title: string;
  body: string;
  /** NULL = common template (shown for every category). */
  categoryId: number | null;
  enabled: boolean;
  updatedAt: string;
}

interface ListOpts {
  /** Composer: the ticket's category → show category-matched + common templates only. */
  categoryId?: number | null;
  /** Manager: include disabled rows (composer never does). */
  includeDisabled?: boolean;
}

/**
 * Agent canned-reply templates, per project (Story 12.2). The composer picker lists only
 * ENABLED templates matching the ticket's category (or common, category=NULL); the admin
 * manager lists everything (incl. disabled) and can toggle enable/disable instead of
 * hard-deleting. Only SSA/Admin/TL may mutate (gated in the controller). Bodies carry
 * {{ticketCode}}/{{requesterName}}/{{agentName}} placeholders, substituted client-side.
 */
@Injectable()
export class ReplyTemplatesService {
  async list(user: SessionUser, projectId: number, opts: ListOpts = {}): Promise<ReplyTemplate[]> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const conds = [eq(replyTemplates.projectId, projectId)];
      if (!opts.includeDisabled) conds.push(eq(replyTemplates.enabled, true));
      // Composer: category-matched OR common (NULL). Manager (no categoryId): all.
      if (opts.categoryId !== undefined && opts.categoryId !== null) {
        conds.push(or(isNull(replyTemplates.categoryId), eq(replyTemplates.categoryId, opts.categoryId))!);
      }
      const rows = await tx
        .select({
          id: replyTemplates.id,
          title: replyTemplates.title,
          body: replyTemplates.body,
          categoryId: replyTemplates.categoryId,
          enabled: replyTemplates.enabled,
          updatedAt: replyTemplates.updatedAt,
        })
        .from(replyTemplates)
        .where(and(...conds))
        // Category-specific templates first (NULLS LAST), then alphabetical by title.
        .orderBy(sql`${replyTemplates.categoryId} asc nulls last`, asc(replyTemplates.title));
      return rows.map((r) => this.toView(r));
    });
  }

  async create(
    user: SessionUser,
    projectId: number,
    input: { title: string; body: string; categoryId?: number | null },
  ): Promise<ReplyTemplate> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      await this.assertCategoryInProject(tx, projectId, input.categoryId);
      const [row] = await tx
        .insert(replyTemplates)
        .values({
          projectId,
          title: input.title,
          body: input.body,
          categoryId: input.categoryId ?? null,
          createdBy: user.id,
        })
        .returning();
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'reply_template.created',
        objectType: 'reply_template',
        objectId: String(row!.id),
        newValue: { title: input.title, categoryId: input.categoryId ?? null },
      });
      return this.toView(row!);
    });
  }

  async update(
    user: SessionUser,
    projectId: number,
    id: number,
    input: { title: string; body: string; categoryId?: number | null },
  ): Promise<ReplyTemplate> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      await this.assertCategoryInProject(tx, projectId, input.categoryId);
      // 12.2 partial-safe: only touch `category_id` when the caller actually sent the
      // field. Omitting it must NOT silently demote a category-scoped template to common
      // (which would leak it into every category's picker). `null` = explicit "common".
      const set: { title: string; body: string; updatedAt: Date; categoryId?: number | null } = {
        title: input.title,
        body: input.body,
        updatedAt: new Date(),
      };
      if (input.categoryId !== undefined) set.categoryId = input.categoryId;
      const [row] = await tx
        .update(replyTemplates)
        .set(set)
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
        newValue: { title: input.title, categoryId: row.categoryId },
      });
      return this.toView(row);
    });
  }

  /** Soft enable/disable (12.2) — hides from the composer picker without deleting. */
  async setEnabled(user: SessionUser, projectId: number, id: number, enabled: boolean): Promise<ReplyTemplate> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .update(replyTemplates)
        .set({ enabled, updatedAt: new Date() })
        .where(and(eq(replyTemplates.id, id), eq(replyTemplates.projectId, projectId)))
        .returning();
      if (!row) throw new NotFoundException('Template not found');
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: enabled ? 'reply_template.enabled' : 'reply_template.disabled',
        objectType: 'reply_template',
        objectId: String(id),
        newValue: { enabled },
      });
      return this.toView(row);
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

  /** A category, when given, must belong to the same project (defence-in-depth). */
  private async assertCategoryInProject(
    tx: Parameters<Parameters<typeof withActor>[1]>[0],
    projectId: number,
    categoryId?: number | null,
  ): Promise<void> {
    if (categoryId === undefined || categoryId === null) return;
    const [cat] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.projectId, projectId)));
    // 422 (not 400): the payload is well-formed, but a category from another project is
    // semantically invalid here (spec 12.2 / IT-TPL-004).
    if (!cat) throw new UnprocessableEntityException('Category not in this project');
  }

  private toView(r: {
    id: number;
    title: string;
    body: string;
    categoryId: number | null;
    enabled: boolean;
    updatedAt: Date;
  }): ReplyTemplate {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      categoryId: r.categoryId,
      enabled: r.enabled,
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
