import { pgEnum } from 'drizzle-orm/pg-core';

/** Fixed projects (NFR6). */
export const projectKeyEnum = pgEnum('project_key', ['hris', 'cnb']);

/** Four fixed roles (FR55). */
export const roleEnum = pgEnum('role', ['ssa', 'admin', 'team_lead', 'member']);

export type ProjectKey = (typeof projectKeyEnum.enumValues)[number];
export type Role = (typeof roleEnum.enumValues)[number];

/** Ticket lifecycle states (FR37). "Reopened" is a flag, not a state; "Closing" is outbox-internal. */
export const ticketStatusEnum = pgEnum('ticket_status', [
  'open',
  'assigned',
  'in_progress',
  'pending',
  'resolved',
  'closed',
]);

/** Message direction. */
export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);

/** Participant approval status (FR3). */
export const participantStatusEnum = pgEnum('participant_status', [
  'active',
  'pending_approval',
  'rejected',
]);

/** Auto-assign strategy (FR25). */
export const assignStrategyEnum = pgEnum('assign_strategy', ['round_robin', 'least_load']);

/** Inbound message pipeline status. blocked = blocklist; suppressed = mail-bomb (party-mode). */
export const inboxStatusEnum = pgEnum('inbox_status', [
  'received',
  'processed',
  'suppressed',
  'blocked',
  'failed',
]);

/** Outbox lifecycle (NFR10). "Closing" in PRD maps to this technical phase. */
export const outboxStatusEnum = pgEnum('outbox_status', [
  'pending',
  'processing',
  'done',
  'failed',
]);

/** Attachment status (party-mode E3 — no `streaming`). `failed` = repair gave up
 *  on a pending row whose file is missing/wrong-size (Story 2.5). */
export const attachmentStatusEnum = pgEnum('attachment_status', [
  'pending',
  'stored',
  'blocked_unsafe',
  'expired',
  'failed',
]);

/** Tag kind. */
export const tagKindEnum = pgEnum('tag_kind', ['manual', 'auto', 'priority']);

/** Draft kind (party-mode — reply vs note draft are independent). */
export const draftKindEnum = pgEnum('draft_kind', ['reply', 'note']);

/** Junk rule kind (FR102). */
export const junkRuleKindEnum = pgEnum('junk_rule_kind', ['keyword', 'sender']);

/** View-log action for sensitive categories (FR67). */
export const viewLogActionEnum = pgEnum('view_log_action', ['ticket_view', 'file_download']);
