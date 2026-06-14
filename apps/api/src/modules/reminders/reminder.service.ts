import { Injectable, Logger } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DEFAULT_OVERDUE_DAYS } from '@hris/shared';
import { withActor, systemActor, type DbTx } from '../../infra/db/with-actor';
import {
  projects as projectsTable,
  reminderConfig,
  tickets,
  categories,
  users,
  userGroupMembership,
  digestLog,
  snoozeReminderLog,
} from '../../infra/db/schema';
import { enqueue, generateMessageId } from '../../infra/queue/outbox.service';
import { loadTemplate, renderTemplate } from '../email-engine/templates';
import { emitNotification } from '../notifications/emit';
import { renderDigest, type DigestTicket } from './digest-render';

const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:8080';
const MS_PER_DAY = 86_400_000;

interface ProjectCfg {
  id: number;
  key: string;
  overdueDays: number;
  digestHour: number;
  digestEnabled: boolean;
  digestMaxN: number;
}

interface RawTicket {
  id: string;
  ticketCode: string;
  subject: string;
  categoryId: number | null;
  assigneeId: string | null;
  status: string;
  snoozeUntil: string | null;
  lastOpenedAt: Date;
  assignedAt: Date | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
}

/** VN calendar date 'YYYY-MM-DD' + 0–23 hour for an instant. */
export function vnParts(now: Date): { dateVn: string; hour: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(now).map((x) => [x.type, x.value]));
  return { dateVn: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

/**
 * Compute the overdue/snooze flags for a ticket relative to `now` (Story 5.6 logic,
 * in TS so the scheduler's fake-clock tests are deterministic). Snooze midnight is
 * anchored to VN (+07:00). Mirrors the SQL in tickets-read.service.
 */
function flagsFor(t: RawTicket, now: Date, dateVn: string, threshold: number) {
  const closedLike = t.status === 'resolved' || t.status === 'closed';
  const snoozePast = t.status === 'pending' && t.snoozeUntil !== null && t.snoozeUntil < dateVn;
  const snoozeWaiting = t.status === 'pending' && t.snoozeUntil !== null && t.snoozeUntil >= dateVn;
  const base = snoozePast ? new Date(`${t.snoozeUntil}T00:00:00+07:00`) : t.lastOpenedAt;
  const ageDays = Math.floor((now.getTime() - base.getTime()) / MS_PER_DAY);
  const isOverdue = !closedLike && !snoozeWaiting && ageDays > threshold;
  const overdueDays = isOverdue ? ageDays - threshold : 0;
  const snoozeDue = t.status === 'pending' && t.snoozeUntil !== null && t.snoozeUntil <= dateVn;
  const wholeAge = Math.floor((now.getTime() - t.lastOpenedAt.getTime()) / MS_PER_DAY);
  return { isOverdue, overdueDays, snoozeDue, snoozeWaiting, ageDays: Math.max(0, wholeAge) };
}

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  /** Scheduler entry — runs every tick (Story 6.2). Sends each project's digest once
   *  it's past the configured VN hour, deduped per (recipient, VN day) via digest_log
   *  (which also yields free catch-up after downtime). Returns counts for logging. */
  async runDigests(now: Date = new Date()): Promise<{ digests: number }> {
    const cfgs = await withActor(systemActor, (tx) =>
      tx
        .select({
          id: projectsTable.id,
          key: projectsTable.key,
          overdueDays: reminderConfig.overdueDays,
          digestHour: reminderConfig.digestHour,
          digestEnabled: reminderConfig.digestEnabled,
          digestMaxN: reminderConfig.digestMaxN,
        })
        .from(projectsTable)
        .leftJoin(reminderConfig, eq(reminderConfig.projectId, projectsTable.id)),
    );

    let digests = 0;
    for (const c of cfgs) {
      const cfg: ProjectCfg = {
        id: c.id,
        key: c.key,
        overdueDays: c.overdueDays ?? DEFAULT_OVERDUE_DAYS,
        digestHour: c.digestHour ?? 8,
        digestEnabled: c.digestEnabled ?? true,
        digestMaxN: c.digestMaxN ?? 20,
      };
      if (!cfg.digestEnabled) continue;
      const { dateVn, hour } = vnParts(now);
      if (hour < cfg.digestHour) continue; // not yet time today
      digests += await this.sendProjectDigests(cfg, now, dateVn);
    }
    return { digests };
  }

  /** Build + enqueue all of one project's digests for `dateVn`. One tx (small system). */
  private async sendProjectDigests(cfg: ProjectCfg, now: Date, dateVn: string): Promise<number> {
    return withActor(systemActor, async (tx) => {
      // Outstanding tickets = overdue OR snooze-due (excludes resolved/closed + in-window snooze).
      const raw = (await tx
        .select({
          id: tickets.id,
          ticketCode: tickets.ticketCode,
          subject: tickets.subject,
          categoryId: tickets.categoryId,
          assigneeId: tickets.assigneeId,
          status: tickets.status,
          snoozeUntil: tickets.snoozeUntil,
          lastOpenedAt: tickets.lastOpenedAt,
          assignedAt: tickets.assignedAt,
        })
        .from(tickets)
        .where(and(eq(tickets.projectId, cfg.id), ne(tickets.status, 'closed'), ne(tickets.status, 'resolved')))) as RawTicket[];

      const cats = await tx
        .select({ id: categories.id, nameVi: categories.nameVi, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, cfg.id));
      const catLabel = new Map(cats.map((c) => [c.id, c.nameVi] as const));

      // Recipient routing inputs: active members/TLs per category + project admins.
      const memberRows = await tx
        .select({ categoryId: userGroupMembership.categoryId, id: users.id, email: users.email, name: users.name, role: users.role })
        .from(userGroupMembership)
        .innerJoin(users, eq(users.id, userGroupMembership.userId))
        .where(and(eq(users.projectId, cfg.id), eq(users.disabled, false)));
      const membersByCat = new Map<number, UserRow[]>();
      const tlsByCat = new Map<number, UserRow[]>();
      for (const m of memberRows) {
        const u: UserRow = { id: m.id, email: m.email, name: m.name, role: m.role };
        (membersByCat.get(m.categoryId) ?? membersByCat.set(m.categoryId, []).get(m.categoryId)!).push(u);
        if (m.role === 'team_lead') (tlsByCat.get(m.categoryId) ?? tlsByCat.set(m.categoryId, []).get(m.categoryId)!).push(u);
      }
      const admins = (await tx
        .select({ id: users.id, email: users.email, name: users.name, role: users.role })
        .from(users)
        .where(and(eq(users.projectId, cfg.id), eq(users.role, 'admin'), eq(users.disabled, false)))) as UserRow[];
      const activeUserIds = new Set(memberRows.map((m) => m.id).concat(admins.map((a) => a.id)));

      // Build recipientId → tickets[].
      const byRecipient = new Map<string, DigestTicket[]>();
      const userById = new Map<string, UserRow>();
      for (const m of memberRows) userById.set(m.id, { id: m.id, email: m.email, name: m.name, role: m.role });
      for (const a of admins) userById.set(a.id, a);

      const add = (uid: string, dt: DigestTicket) => {
        if (!activeUserIds.has(uid)) return; // never digest a disabled user (M10)
        (byRecipient.get(uid) ?? byRecipient.set(uid, []).get(uid)!).push(dt);
      };

      for (const t of raw) {
        const f = flagsFor(t, now, dateVn, cfg.overdueDays);
        if (!f.isOverdue && !f.snoozeDue) continue; // not outstanding
        const dt: DigestTicket = {
          id: t.id,
          ticketCode: t.ticketCode,
          subject: t.subject,
          categoryId: t.categoryId,
          categoryLabel: (t.categoryId !== null ? catLabel.get(t.categoryId) : undefined) ?? '—',
          snoozeDue: f.snoozeDue,
          isOverdue: f.isOverdue,
          overdueDays: f.overdueDays,
          assignedAt: t.assignedAt ? t.assignedAt.getTime() : null,
          lastOpenedAt: t.lastOpenedAt.getTime(),
          ageDays: f.ageDays,
        };
        const cat = t.categoryId;
        const tls = (cat !== null && tlsByCat.get(cat)) || [];
        const tlOrAdmin = tls.length > 0 ? tls : admins; // no TL in group → project admins
        const assignee = t.assigneeId ? userById.get(t.assigneeId) : undefined;
        const assigneeActive = !!assignee; // userById only holds ACTIVE users

        if (assigneeActive) {
          add(t.assigneeId!, dt);
          for (const u of tlOrAdmin) add(u.id, dt);
        } else {
          // Pool, or assignee is disabled/left → whole group + TL (or admins).
          const members = (cat !== null && membersByCat.get(cat)) || [];
          for (const u of members) add(u.id, dt);
          for (const u of tlOrAdmin) add(u.id, dt);
        }
      }

      if (byRecipient.size === 0) return 0;

      const tpl = await loadTemplate(tx, cfg.id, 'digest');
      let sent = 0;
      for (const [uid, list] of byRecipient) {
        const u = userById.get(uid)!;
        // Dedup: claim today's slot FIRST; a conflict means already sent → skip.
        const claimed = await tx
          .insert(digestLog)
          .values({ recipient: u.email, dateVn })
          .onConflictDoNothing({ target: [digestLog.recipient, digestLog.dateVn] })
          .returning({ id: digestLog.id });
        if (claimed.length === 0) continue;

        const rendered = tpl
          ? renderTemplate(tpl, 'vi', { requesterName: u.name })
          : { subject: 'Digest', bodyText: '', bodyHtml: '' };
        const body = renderDigest(
          {
            recipientName: u.name,
            tickets: list,
            maxN: cfg.digestMaxN,
            baseUrl: APP_BASE_URL,
            junkCount: u.role === 'admin' ? await this.junkCount(tx, cfg.id) : undefined,
            introHtml: rendered.bodyHtml,
            introText: rendered.bodyText,
          },
          'vi',
        );
        await enqueue(tx, {
          projectId: cfg.id,
          to: [u.email],
          subject: rendered.subject,
          bodyHtml: body.bodyHtml,
          bodyText: body.bodyText,
          messageId: generateMessageId(`digest@${cfg.key}.pmh.com.vn`),
          // Dedup is the digest_log claim above; the outbox key stays a random UUID.
          headers: { autoSubmitted: true },
        });
        sent += 1;
      }
      if (sent > 0) this.logger.log(`digest[${cfg.key}] ${dateVn}: ${sent} sent`);
      return sent;
    });
  }

  /**
   * Snooze-due reminders (Story 6.3, FR50 — FIXED, ignores the digest toggle). Once
   * per VN day per ticket (snooze_reminder_log), e-mail + in-app `snooze_due` the
   * assignee; if they're disabled/gone, route to the group's TLs (or project admins).
   */
  async runSnoozeReminders(now: Date = new Date()): Promise<{ reminders: number }> {
    const { dateVn } = vnParts(now);
    return withActor(systemActor, async (tx) => {
      const due = await tx
        .select({
          id: tickets.id,
          ticketCode: tickets.ticketCode,
          subject: tickets.subject,
          projectId: tickets.projectId,
          projectKey: projectsTable.key,
          categoryId: tickets.categoryId,
          assigneeId: tickets.assigneeId,
        })
        .from(tickets)
        .innerJoin(projectsTable, eq(projectsTable.id, tickets.projectId))
        .where(and(eq(tickets.status, 'pending'), eq(tickets.snoozeUntil, dateVn)));

      let reminders = 0;
      for (const t of due) {
        const claimed = await tx
          .insert(snoozeReminderLog)
          .values({ ticketId: t.id, dateVn })
          .onConflictDoNothing({ target: [snoozeReminderLog.ticketId, snoozeReminderLog.dateVn] })
          .returning({ id: snoozeReminderLog.id });
        if (claimed.length === 0) continue; // already reminded today

        const recipients = await this.snoozeRecipients(tx, t.projectId, t.categoryId, t.assigneeId);
        if (recipients.length === 0) continue;

        for (const r of recipients) {
          await emitNotification(tx, {
            actorId: r.id,
            type: 'snooze_due',
            payload: { ticketId: t.id, ticketCode: t.ticketCode },
          });
        }
        const tpl = await loadTemplate(tx, t.projectId, 'snooze_due');
        if (tpl) {
          const link = `${APP_BASE_URL}/tickets/${t.id}`;
          const rendered = renderTemplate(tpl, 'vi', {
            ticketCode: t.ticketCode,
            subject: t.subject,
            link,
          });
          await enqueue(tx, {
            projectId: t.projectId,
            ticketId: t.id,
            to: recipients.map((r) => r.email),
            subject: rendered.subject,
            bodyHtml: rendered.bodyHtml,
            bodyText: rendered.bodyText,
            messageId: generateMessageId(`snooze@${t.projectKey}.pmh.com.vn`),
            // Dedup is the snooze_reminder_log claim above.
            headers: { autoSubmitted: true },
          });
        }
        reminders += 1;
      }
      if (reminders > 0) this.logger.log(`snooze reminders ${dateVn}: ${reminders}`);
      return { reminders };
    });
  }

  /** Assignee (if active) else the group's TLs, else project admins (M10). */
  private async snoozeRecipients(
    tx: DbTx,
    projectId: number,
    categoryId: number | null,
    assigneeId: string | null,
  ): Promise<UserRow[]> {
    if (assigneeId) {
      const [a] = await tx
        .select({ id: users.id, email: users.email, name: users.name, role: users.role })
        .from(users)
        .where(and(eq(users.id, assigneeId), eq(users.disabled, false)));
      if (a) return [a];
    }
    if (categoryId !== null) {
      const tls = await tx
        .select({ id: users.id, email: users.email, name: users.name, role: users.role })
        .from(userGroupMembership)
        .innerJoin(users, eq(users.id, userGroupMembership.userId))
        .where(
          and(
            eq(userGroupMembership.categoryId, categoryId),
            eq(users.role, 'team_lead'),
            eq(users.disabled, false),
          ),
        );
      if (tls.length > 0) return tls;
    }
    return tx
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(and(eq(users.projectId, projectId), eq(users.role, 'admin'), eq(users.disabled, false)));
  }

  private async junkCount(tx: DbTx, projectId: number): Promise<number> {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.isJunk, true)));
    return rows.length;
  }
}
