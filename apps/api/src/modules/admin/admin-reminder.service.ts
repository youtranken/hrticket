import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor } from '../../infra/db/with-actor';
import { reminderConfig, emailTemplates } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import { loadTemplate, renderTemplate } from '../email-engine/templates';
import { enqueue, generateMessageId } from '../../infra/queue/outbox.service';
import { renderDigest } from '../reminders/digest-render';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from '../tickets/actor';

const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:8080';

/** Allowed placeholders per template key — a PUT with anything else is rejected so a
 *  typo can never silently render blank in a real email (Story 6.4 AC3). */
const PLACEHOLDERS: Record<string, string[]> = {
  auto_ack: ['ticketCode', 'subject', 'requesterName'],
  digest: ['requesterName'],
  snooze_due: ['ticketCode', 'subject', 'link'],
  ticket_reopened: ['ticketCode', 'subject', 'by', 'link'],
  reopen_locked_notice: ['ticketCode', 'subject', 'requesterName'],
};
const EDITABLE_KEYS = Object.keys(PLACEHOLDERS);

export interface ReminderConfigView {
  overdueDays: number;
  digestHour: number;
  /** Đơn 12: minute component of the send time (default 08:30). */
  digestMinute: number;
  digestEnabled: boolean;
  digestMaxN: number;
  /** Đơn 12: pool tickets unclaimed >= this many days enter the admin digest. */
  poolUnclaimedDays: number;
}

/** PUT payload — the đơn-12 fields are optional so older callers keep working;
 *  absent values fall back to the defaults (08:30 / 2 days). */
export type ReminderConfigInput = Omit<ReminderConfigView, 'digestMinute' | 'poolUnclaimedDays'> &
  Partial<Pick<ReminderConfigView, 'digestMinute' | 'poolUnclaimedDays'>>;

function unknownPlaceholders(text: string, allowed: string[]): string[] {
  const found = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!);
  return [...new Set(found.filter((k) => !allowed.includes(k)))];
}

/** Reminder config + email-template administration (Story 6.4). Scope is resolved by
 *  the controller (Admin → own project, SSA → X-Project); every write is audited. */
@Injectable()
export class AdminReminderService {
  async getConfig(user: SessionUser, projectId: number): Promise<ReminderConfigView> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [row] = await tx
        .select({
          overdueDays: reminderConfig.overdueDays,
          digestHour: reminderConfig.digestHour,
          digestMinute: reminderConfig.digestMinute,
          digestEnabled: reminderConfig.digestEnabled,
          digestMaxN: reminderConfig.digestMaxN,
          poolUnclaimedDays: reminderConfig.poolUnclaimedDays,
        })
        .from(reminderConfig)
        .where(eq(reminderConfig.projectId, projectId));
      return (
        row ?? {
          overdueDays: 3,
          digestHour: 8,
          digestMinute: 30,
          digestEnabled: true,
          digestMaxN: 20,
          poolUnclaimedDays: 2,
        }
      );
    });
  }

  async putConfig(
    user: SessionUser,
    projectId: number,
    input: ReminderConfigInput,
  ): Promise<ReminderConfigView> {
    const full: ReminderConfigView = {
      ...input,
      digestMinute: input.digestMinute ?? 30,
      poolUnclaimedDays: input.poolUnclaimedDays ?? 2,
    };
    if (full.overdueDays < 1) throw new UnprocessableEntityException('overdueDays must be >= 1');
    if (full.digestHour < 0 || full.digestHour > 23) {
      throw new UnprocessableEntityException('digestHour must be 0..23');
    }
    if (full.digestMinute < 0 || full.digestMinute > 59) {
      throw new UnprocessableEntityException('digestMinute must be 0..59');
    }
    if (full.digestMaxN < 1) throw new UnprocessableEntityException('digestMaxN must be >= 1');
    if (full.poolUnclaimedDays < 0) {
      throw new UnprocessableEntityException('poolUnclaimedDays must be >= 0');
    }
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [old] = await tx
        .select()
        .from(reminderConfig)
        .where(eq(reminderConfig.projectId, projectId));
      await tx
        .insert(reminderConfig)
        .values({ projectId, ...full })
        .onConflictDoUpdate({ target: reminderConfig.projectId, set: full });
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'reminder_config.updated',
        objectType: 'reminder_config',
        objectId: String(projectId),
        oldValue: old ?? null,
        newValue: full,
      });
      return full;
    });
  }

  async listTemplates(user: SessionUser, projectId: number) {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const rows = await tx
        .select({
          key: emailTemplates.key,
          subjectVi: emailTemplates.subjectVi,
          subjectEn: emailTemplates.subjectEn,
          bodyVi: emailTemplates.bodyVi,
          bodyEn: emailTemplates.bodyEn,
        })
        .from(emailTemplates)
        .where(eq(emailTemplates.projectId, projectId));
      return rows
        .filter((r) => EDITABLE_KEYS.includes(r.key))
        .map((r) => ({ ...r, placeholders: PLACEHOLDERS[r.key] ?? [] }));
    });
  }

  async putTemplate(
    user: SessionUser,
    projectId: number,
    key: string,
    input: { subjectVi: string; subjectEn: string; bodyVi: string; bodyEn: string },
  ) {
    const allowed = PLACEHOLDERS[key];
    if (!allowed) throw new NotFoundException('Unknown template');
    const bad = [
      ...unknownPlaceholders(input.subjectVi, allowed),
      ...unknownPlaceholders(input.subjectEn, allowed),
      ...unknownPlaceholders(input.bodyVi, allowed),
      ...unknownPlaceholders(input.bodyEn, allowed),
    ];
    if (bad.length > 0) {
      throw new UnprocessableEntityException(`Unknown placeholders: ${[...new Set(bad)].join(', ')}`);
    }
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [old] = await tx
        .select()
        .from(emailTemplates)
        .where(and(eq(emailTemplates.projectId, projectId), eq(emailTemplates.key, key)));
      if (!old) throw new NotFoundException('Template not seeded for this project');
      await tx
        .update(emailTemplates)
        .set(input)
        .where(and(eq(emailTemplates.projectId, projectId), eq(emailTemplates.key, key)));
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'email_template.updated',
        objectType: 'email_template',
        objectId: key,
        oldValue: { subjectVi: old.subjectVi, bodyVi: old.bodyVi },
        newValue: { subjectVi: input.subjectVi, bodyVi: input.bodyVi },
      });
      return { ok: true };
    });
  }

  /** Render the template with SAMPLE data and send it to the requesting admin (FR53,
   *  like the SMTP connection test). Goes through the outbox like any other mail. */
  async testSend(user: SessionUser, projectId: number, key: string): Promise<{ to: string }> {
    if (!PLACEHOLDERS[key]) throw new NotFoundException('Unknown template');
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const tpl = await loadTemplate(tx, projectId, key);
      if (!tpl) throw new NotFoundException('Template not seeded for this project');

      const link = `${APP_BASE_URL}/tickets/sample`;
      const vars = {
        ticketCode: '#00001',
        subject: 'Yêu cầu mẫu (gửi thử)',
        requesterName: user.name,
        by: 'requester@example.com',
        link,
      };
      const rendered = renderTemplate(tpl, 'vi', vars);

      let bodyHtml = rendered.bodyHtml;
      let bodyText = rendered.bodyText;
      if (key === 'digest') {
        // Digest body is code-generated — show a tiny sample list so "Gửi thử" looks real.
        const sample = renderDigest(
          {
            recipientName: user.name,
            baseUrl: APP_BASE_URL,
            maxN: 20,
            introHtml: rendered.bodyHtml,
            introText: rendered.bodyText,
            tickets: [
              { id: 's1', ticketCode: '#00001', subject: 'Hỏi về nghỉ phép', categoryId: 1, categoryLabel: 'Nghỉ phép', snoozeDue: false, isOverdue: true, overdueDays: 2, assignedAt: 1, lastOpenedAt: 1, ageDays: 5 },
              { id: 's2', ticketCode: '#00002', subject: 'Bảng lương tháng 6', categoryId: 2, categoryLabel: 'Lương', snoozeDue: true, isOverdue: false, overdueDays: 0, assignedAt: 2, lastOpenedAt: 2, ageDays: 1 },
            ],
          },
          'vi',
        );
        bodyHtml = sample.bodyHtml;
        bodyText = sample.bodyText;
      }

      await enqueue(tx, {
        projectId,
        to: [user.email],
        subject: `[TEST] ${rendered.subject}`,
        bodyHtml,
        bodyText,
        messageId: generateMessageId('test-send@pmh.com.vn'),
        headers: { autoSubmitted: true },
      });
      return { to: user.email };
    });
  }
}
