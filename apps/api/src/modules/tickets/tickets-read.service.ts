import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import {
  tickets,
  ticketMessages,
  participants,
  attachments,
  tags,
  ticketTags,
  ticketLink,
  categories,
  projects,
} from '../../infra/db/schema';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';
import { signedFileUrl } from '../../infra/crypto/signed-url';

/** Replace the stable inline-image placeholders left by the sanitizer (3.7) with
 *  freshly-signed, short-lived URLs at READ time (a stored token would be stale). */
function signInlineImages(html: string | null): string | null {
  if (!html) return html;
  return html.replace(
    /\/api\/files\/([0-9a-fA-F-]{36})(?!\?)/g,
    (_m, id: string) => signedFileUrl(id),
  );
}

export interface TicketListItem {
  id: string;
  ticketCode: string;
  projectKey: string;
  subject: string;
  requesterEmail: string;
  status: string;
  category: { vi: string; en: string } | null;
  tags: { name: string; color: string | null }[];
  createdAt: Date;
}

export interface TicketListResult {
  items: TicketListItem[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class TicketsReadService {
  /** Paginated, RLS-filtered ticket list (newest first). FR8. */
  async list(user: SessionUser, page = 1, pageSize = 20): Promise<TicketListResult> {
    const actor = await actorForUser(user);
    const offset = (page - 1) * pageSize;
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          id: tickets.id,
          ticketCode: tickets.ticketCode,
          projectKey: projects.key,
          subject: tickets.subject,
          requesterEmail: tickets.requesterEmail,
          status: tickets.status,
          categoryVi: categories.nameVi,
          categoryEn: categories.nameEn,
          createdAt: tickets.createdAt,
        })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .orderBy(desc(tickets.createdAt))
        .limit(pageSize)
        .offset(offset);

      const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(tickets);
      const total = countRows[0]?.count ?? 0;

      const ids = rows.map((r) => r.id);
      const tagRows = ids.length
        ? await tx
            .select({ ticketId: ticketTags.ticketId, name: tags.name, color: tags.color })
            .from(ticketTags)
            .innerJoin(tags, eq(tags.id, ticketTags.tagId))
            .where(inArray(ticketTags.ticketId, ids))
        : [];

      const items: TicketListItem[] = rows.map((r) => ({
        id: r.id,
        ticketCode: r.ticketCode,
        projectKey: r.projectKey,
        subject: r.subject,
        requesterEmail: r.requesterEmail,
        status: r.status,
        category: r.categoryVi ? { vi: r.categoryVi, en: r.categoryEn! } : null,
        tags: tagRows.filter((t) => t.ticketId === r.id).map((t) => ({ name: t.name, color: t.color })),
        createdAt: r.createdAt,
      }));

      return { items, total, page, pageSize };
    });
  }

  /** Full ticket with conversation, participants, tags, attachment metadata, links.
   *  Invisible (RLS) → 404, no existence leak. Body is plain-text for now (HTML
   *  sanitisation is Story 3.7). FR12/FR19. */
  async getDetail(user: SessionUser, id: string) {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          id: tickets.id,
          ticketCode: tickets.ticketCode,
          projectKey: projects.key,
          projectName: projects.name,
          subject: tickets.subject,
          requesterEmail: tickets.requesterEmail,
          status: tickets.status,
          categoryVi: categories.nameVi,
          categoryEn: categories.nameEn,
          createdAt: tickets.createdAt,
        })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .where(eq(tickets.id, id));
      if (!t) throw new NotFoundException('Ticket not found');

      const messages = await tx
        .select({
          id: ticketMessages.id,
          direction: ticketMessages.direction,
          fromAddr: ticketMessages.fromAddr,
          toAddrs: ticketMessages.toAddrs,
          ccAddrs: ticketMessages.ccAddrs,
          bccAddrs: ticketMessages.bccAddrs,
          bodyText: ticketMessages.bodyText,
          bodyHtmlSafe: ticketMessages.bodyHtmlSafe,
          isAutoReply: ticketMessages.isAutoReply,
          isInternal: ticketMessages.isInternal,
          createdAt: ticketMessages.createdAt,
        })
        .from(ticketMessages)
        .where(eq(ticketMessages.ticketId, id))
        .orderBy(asc(ticketMessages.createdAt));

      const ppl = await tx
        .select({ id: participants.id, email: participants.email, status: participants.status })
        .from(participants)
        .where(eq(participants.ticketId, id));

      const tg = await tx
        .select({ name: tags.name, color: tags.color })
        .from(ticketTags)
        .innerJoin(tags, eq(tags.id, ticketTags.tagId))
        .where(eq(ticketTags.ticketId, id));

      const att = await tx
        .select({
          id: attachments.id,
          fileName: attachments.fileName,
          mimeType: attachments.mimeType,
          size: attachments.size,
          status: attachments.status,
        })
        .from(attachments)
        .where(eq(attachments.ticketId, id));

      // Cross-post / linked tickets (the other side of each link), if visible.
      const linkRows = await tx
        .select({ a: ticketLink.ticketA, b: ticketLink.ticketB, kind: ticketLink.kind })
        .from(ticketLink)
        .where(or(eq(ticketLink.ticketA, id), eq(ticketLink.ticketB, id)));
      const otherIds = linkRows.map((l) => (l.a === id ? l.b : l.a));
      const linkedTickets = otherIds.length
        ? await tx
            .select({ id: tickets.id, ticketCode: tickets.ticketCode, projectKey: projects.key })
            .from(tickets)
            .innerJoin(projects, eq(projects.id, tickets.projectId))
            .where(inArray(tickets.id, otherIds))
        : [];

      return {
        ticket: {
          id: t.id,
          ticketCode: t.ticketCode,
          projectKey: t.projectKey,
          projectName: t.projectName,
          subject: t.subject,
          requesterEmail: t.requesterEmail,
          status: t.status,
          category: t.categoryVi ? { vi: t.categoryVi, en: t.categoryEn! } : null,
          createdAt: t.createdAt,
        },
        messages: messages.map((m) => ({ ...m, bodyHtmlSafe: signInlineImages(m.bodyHtmlSafe) })),
        participants: ppl,
        tags: tg,
        attachments: att,
        links: linkedTickets.map((l) => ({ ...l, kind: 'cross_post' })),
      };
    });
  }
}
