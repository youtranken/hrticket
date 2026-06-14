import {
  pgTable,
  bigserial,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  date,
  primaryKey,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { projectKeyEnum, roleEnum, assignStrategyEnum } from './enums';

/** Two fixed projects (NFR6). */
export const projects = pgTable('projects', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  key: projectKeyEnum('key').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Internal users. Disabled only, never deleted (FR63). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: integer('project_id').references(() => projects.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role').notNull(),
    disabled: boolean('disabled').notNull().default(false),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    otpEnabled: boolean('otp_enabled').notNull().default(false),
    language: text('language').notNull().default('vi'),
    awayFrom: date('away_from'),
    awayTo: date('away_to'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_users_email').on(t.email), index('idx_users_project').on(t.projectId)],
);

/** Runtime role→capability matrix (FR55). Only SSA edits; Guards read with short cache. */
export const roleCapabilities = pgTable(
  'role_capabilities',
  {
    role: roleEnum('role').notNull(),
    capability: text('capability').notNull(),
    allowed: boolean('allowed').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.role, t.capability] })],
);

/** Category = permission group (FR24). Bilingual data, sensitive flag, soft-delete. */
export const categories = pgTable(
  'categories',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    nameVi: text('name_vi').notNull(),
    nameEn: text('name_en').notNull(),
    isSensitive: boolean('is_sensitive').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false), // "Khác" is system
    disabled: boolean('disabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_categories_project').on(t.projectId),
    // Natural key: a project can't have two categories with the same English name.
    // Also makes the seed idempotent (onConflictDoNothing needs a real target).
    unique('uq_categories_project_name_en').on(t.projectId, t.nameEn),
  ],
);

/** Keywords used to auto-classify into a category (FR21). */
export const categoryKeywords = pgTable(
  'category_keywords',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    keyword: text('keyword').notNull(),
  },
  (t) => [
    index('idx_category_keywords_cat').on(t.categoryId),
    // Real conflict target so re-seed / re-add is idempotent (CLAUDE.md pitfall).
    unique('uq_category_keyword').on(t.categoryId, t.keyword),
  ],
);

/** User ↔ category membership (FR58). 1 user belongs to n categories. */
export const userGroupMembership = pgTable(
  'user_group_membership',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.categoryId] })],
);

/** Auto-assign config per category group (FR87). */
export const autoAssignConfig = pgTable('auto_assign_config', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  categoryId: integer('category_id')
    .notNull()
    .references(() => categories.id)
    .unique(),
  strategy: assignStrategyEnum('strategy').notNull().default('round_robin'),
});

/** Ordered members for round-robin (FR25). */
export const autoAssignMembers = pgTable(
  'auto_assign_members',
  {
    configId: integer('config_id')
      .notNull()
      .references(() => autoAssignConfig.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.configId, t.userId] })],
);

/** Round-robin cursor per group (NFR9 — replaces Redis INCR). */
export const assignCursors = pgTable('assign_cursors', {
  categoryId: integer('category_id')
    .primaryKey()
    .references(() => categories.id),
  lastUserId: uuid('last_user_id').references(() => users.id),
});

/** Per-project ticket number counter (G1 — race-free `#00001`). */
export const projectCounters = pgTable('project_counters', {
  projectId: integer('project_id')
    .primaryKey()
    .references(() => projects.id),
  lastNo: integer('last_no').notNull().default(0),
});
