import * as argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { db, sql } from './db';
import * as s from './schema';

/**
 * Idempotent seed: 2 projects, 6 default categories/project (bilingual),
 * role_capabilities per the PRD §2 matrix, project_counters=0, reminder_config
 * + project_settings defaults, email_connections from env, and the first SSA.
 * Re-running does not duplicate (ON CONFLICT DO NOTHING).
 */

const DEFAULT_CATEGORIES: Array<{
  vi: string;
  en: string;
  system?: boolean;
  sensitive?: boolean;
  keywords?: string[];
}> = [
  // Keywords are matched accent- + case-insensitively (f_unaccent) as substrings,
  // so they stay distinctive to avoid cross-category false positives (Story 4.1).
  { vi: 'Chấm công', en: 'Attendance', keywords: ['chấm công', 'timesheet', 'đi trễ'] },
  { vi: 'Nghỉ phép', en: 'Leave', keywords: ['nghỉ phép', 'annual leave'] },
  { vi: 'OT', en: 'Overtime', keywords: ['tăng ca', 'overtime', 'làm thêm giờ'] },
  { vi: 'Lương', en: 'Payroll', sensitive: true, keywords: ['lương', 'payroll', 'bảng lương', 'salary'] },
  { vi: 'Bảo hiểm', en: 'Insurance', sensitive: true, keywords: ['bảo hiểm', 'bhxh', 'bhyt', 'insurance'] },
  { vi: 'Khác', en: 'Other', system: true },
];

// System auto-tags (FR33) + a default priority tag with keyword rules (FR32).
// Tag names are DATA, so Vietnamese is allowed here (unlike code/i18n keys).
const AUTO_TAGS: Array<{ name: string; color: string }> = [
  { name: 'Attachment', color: '#fa8c16' },
  { name: 'Cross-post', color: '#fa8c16' },
  { name: 'Auto-reply', color: '#fa8c16' },
];
const PRIORITY_TAGS: Array<{ name: string; color: string; keywords: string[] }> = [
  { name: 'Ưu tiên cao', color: '#f5222d', keywords: ['khẩn', 'gấp', 'urgent'] },
];

// Bilingual email templates (FR10/FR53). Placeholders: {{ticketCode}} {{subject}}
// {{requesterName}}. Seeded per project; SSA edits wording at runtime (Epic 6/11).
const TEMPLATES: Array<{
  key: string;
  subjectVi: string;
  subjectEn: string;
  bodyVi: string;
  bodyEn: string;
}> = [
  {
    key: 'auto_ack',
    subjectVi: '[{{ticketCode}}] Đã tiếp nhận yêu cầu của bạn',
    subjectEn: '[{{ticketCode}}] We have received your request',
    bodyVi:
      'Chào {{requesterName}},\n\nChúng tôi đã tiếp nhận yêu cầu "{{subject}}" và tạo phiếu mã {{ticketCode}}.\nVui lòng trả lời ngay trên email này nếu cần bổ sung thông tin.\n\nTrân trọng,\nBộ phận Nhân sự',
    bodyEn:
      'Hi {{requesterName}},\n\nWe have received your request "{{subject}}" and opened ticket {{ticketCode}}.\nPlease reply directly to this email if you have anything to add.\n\nBest regards,\nHR Team',
  },
  {
    key: 'reopen_locked_notice',
    subjectVi: '[{{ticketCode}}] Yêu cầu đã đóng — vui lòng tạo yêu cầu mới',
    subjectEn: '[{{ticketCode}}] This request is closed — please open a new one',
    bodyVi:
      'Chào {{requesterName}},\n\nPhiếu {{ticketCode}} đã đóng và không thể mở lại. Vui lòng gửi một email mới để tạo yêu cầu mới.\n\nTrân trọng,\nBộ phận Nhân sự',
    bodyEn:
      'Hi {{requesterName}},\n\nTicket {{ticketCode}} is closed and cannot be reopened. Please send a new email to open a new request.\n\nBest regards,\nHR Team',
  },
  {
    key: 'digest',
    subjectVi: 'Tổng hợp phiếu cần xử lý',
    subjectEn: 'Your open tickets digest',
    bodyVi: 'Chào {{requesterName}},\n\nDanh sách phiếu cần chú ý hôm nay.\n\nBộ phận Nhân sự',
    bodyEn: 'Hi {{requesterName}},\n\nHere are the tickets needing attention today.\n\nHR Team',
  },
  {
    key: 'snooze_due',
    subjectVi: '[{{ticketCode}}] Đến hạn xử lý lại',
    subjectEn: '[{{ticketCode}}] Snoozed ticket is due',
    bodyVi:
      'Phiếu {{ticketCode}} "{{subject}}" đã đến hạn hẹn lại — vui lòng tiếp tục xử lý.\nMở phiếu: {{link}}\n\nBộ phận Nhân sự',
    bodyEn:
      'Ticket {{ticketCode}} "{{subject}}" has reached its snooze date — please pick it back up.\nOpen ticket: {{link}}\n\nHR Team',
  },
  {
    key: 'ticket_reopened',
    subjectVi: '[{{ticketCode}}] Phiếu được mở lại',
    subjectEn: '[{{ticketCode}}] Ticket reopened',
    bodyVi:
      'Phiếu {{ticketCode}} "{{subject}}" vừa được mở lại bởi {{by}}.\nMở phiếu: {{link}}\n\nBộ phận Nhân sự',
    bodyEn:
      'Ticket {{ticketCode}} "{{subject}}" was reopened by {{by}}.\nOpen ticket: {{link}}\n\nHR Team',
  },
];

// PRD §2 capability matrix — coarse seed (SSA edits at runtime, Story 9.4).
const CAPABILITIES: Array<{ role: s.Role; capability: string; allowed: boolean }> = [
  { role: 'member', capability: 'ticket.reply', allowed: true },
  { role: 'member', capability: 'ticket.claim', allowed: true },
  { role: 'member', capability: 'ticket.assign_others', allowed: false },
  { role: 'team_lead', capability: 'ticket.assign_others', allowed: true },
  { role: 'team_lead', capability: 'log.read_group', allowed: true },
  { role: 'admin', capability: 'config.manage', allowed: true },
  { role: 'admin', capability: 'user.manage', allowed: true },
  { role: 'ssa', capability: 'role.edit_capabilities', allowed: true },
  { role: 'ssa', capability: 'config.manage_all', allowed: true },
];

export async function seedOnce(): Promise<void> {
  const projectKeys: Array<{ key: s.ProjectKey; name: string }> = [
    { key: 'hris', name: 'HRIS (ask.hris)' },
    { key: 'cnb', name: 'C&B (cnb)' },
  ];

  await db.transaction(async (tx) => {
    // Projects
    for (const p of projectKeys) {
      await tx.insert(s.projects).values(p).onConflictDoNothing({ target: s.projects.key });
    }
    const projectRows = await tx.select().from(s.projects);
    const byKey = new Map(projectRows.map((p) => [p.key, p.id]));

    for (const proj of projectRows) {
      // Categories
      for (const c of DEFAULT_CATEGORIES) {
        await tx
          .insert(s.categories)
          .values({
            projectId: proj.id,
            nameVi: c.vi,
            nameEn: c.en,
            isSensitive: c.sensitive ?? false,
            isSystem: c.system ?? false,
          })
          .onConflictDoNothing({ target: [s.categories.projectId, s.categories.nameEn] });
      }
      // Classification keywords (FR21) — id needed, so re-read the categories.
      const catRows = await tx
        .select({ id: s.categories.id, nameEn: s.categories.nameEn })
        .from(s.categories)
        .where(eq(s.categories.projectId, proj.id));
      const catByEn = new Map(catRows.map((r) => [r.nameEn, r.id]));
      for (const c of DEFAULT_CATEGORIES) {
        const catId = catByEn.get(c.en);
        if (!catId || !c.keywords) continue;
        for (const kw of c.keywords) {
          await tx
            .insert(s.categoryKeywords)
            .values({ categoryId: catId, keyword: kw })
            .onConflictDoNothing({ target: [s.categoryKeywords.categoryId, s.categoryKeywords.keyword] });
        }
      }
      // Auto-tags (FR33) + priority tags with keyword rules (FR32).
      for (const tg of AUTO_TAGS) {
        await tx
          .insert(s.tags)
          .values({ projectId: proj.id, name: tg.name, kind: 'auto', color: tg.color })
          .onConflictDoNothing({ target: [s.tags.projectId, s.tags.name] });
      }
      for (const tg of PRIORITY_TAGS) {
        await tx
          .insert(s.tags)
          .values({ projectId: proj.id, name: tg.name, kind: 'priority', color: tg.color })
          .onConflictDoNothing({ target: [s.tags.projectId, s.tags.name] });
        const [row] = await tx
          .select({ id: s.tags.id })
          .from(s.tags)
          .where(and(eq(s.tags.projectId, proj.id), eq(s.tags.name, tg.name)));
        if (row) {
          for (const kw of tg.keywords) {
            await tx
              .insert(s.tagKeywords)
              .values({ tagId: row.id, keyword: kw })
              .onConflictDoNothing({ target: [s.tagKeywords.tagId, s.tagKeywords.keyword] });
          }
        }
      }
      // Counters / config / settings
      await tx
        .insert(s.projectCounters)
        .values({ projectId: proj.id, lastNo: 0 })
        .onConflictDoNothing();
      await tx.insert(s.reminderConfig).values({ projectId: proj.id }).onConflictDoNothing();
      await tx
        .insert(s.projectSettings)
        .values({
          projectId: proj.id,
          allowedExtensions: ['mp3', 'mp4', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'],
        })
        .onConflictDoNothing();
      // Email templates (FR10) — conflict target (project_id, key) keeps re-seed idempotent.
      for (const tpl of TEMPLATES) {
        await tx
          .insert(s.emailTemplates)
          .values({
            projectId: proj.id,
            key: tpl.key,
            subjectVi: tpl.subjectVi,
            subjectEn: tpl.subjectEn,
            bodyVi: tpl.bodyVi,
            bodyEn: tpl.bodyEn,
          })
          .onConflictDoNothing({ target: [s.emailTemplates.projectId, s.emailTemplates.key] });
      }
    }

    // Role capabilities
    for (const cap of CAPABILITIES) {
      await tx.insert(s.roleCapabilities).values(cap).onConflictDoNothing();
    }

    // First SSA (belongs to hris project for login scoping; sees both via role).
    const ssaEmail = process.env.SEED_SSA_EMAIL ?? 'ssa@pmh.com.vn';
    const ssaPassword = process.env.SEED_SSA_PASSWORD ?? 'change-me-on-first-login';
    const passwordHash = await argon2.hash(ssaPassword, { type: argon2.argon2id });
    await tx
      .insert(s.users)
      .values({
        projectId: byKey.get('hris')!,
        email: ssaEmail,
        name: 'Super Admin',
        passwordHash,
        role: 'ssa',
        mustChangePassword: true,
      })
      .onConflictDoNothing({ target: s.users.email });

    // Dev-only role fixtures for FE-DT / Playwright (the sidebar-by-role matrix).
    // Gated so production seed never creates them. Ready-to-login (no forced change).
    if (process.env.SEED_DEV_USERS === 'true') {
      const devPassword = process.env.SEED_DEV_PASSWORD ?? 'dev-password-123';
      // The dev SSA keeps a SEPARATE password (the e2e suite logs SSA in with SSA_PW, not
      // DEV_PW) so the role-permission/project-switcher specs work without an env override.
      const ssaDevPassword = process.env.SEED_SSA_DEV_PASSWORD ?? 'Pmh@1234';
      const devHash = await argon2.hash(devPassword, { type: argon2.argon2id });
      const ssaDevHash = await argon2.hash(ssaDevPassword, { type: argon2.argon2id });
      const devUsers: Array<{ email: string; name: string; role: s.Role }> = [
        { email: 'member@dev.local', name: 'Dev Member', role: 'member' },
        { email: 'lead@dev.local', name: 'Dev Team Lead', role: 'team_lead' },
        { email: 'admin@dev.local', name: 'Dev Admin', role: 'admin' },
        { email: 'ssa@dev.local', name: 'Dev SSA', role: 'ssa' },
      ];
      for (const u of devUsers) {
        await tx
          .insert(s.users)
          .values({
            projectId: byKey.get('hris')!,
            email: u.email,
            name: u.name,
            passwordHash: u.role === 'ssa' ? ssaDevHash : devHash,
            role: u.role,
            mustChangePassword: false,
          })
          .onConflictDoNothing({ target: s.users.email });
      }

      // Wire dev users into category groups + an auto-assign roster so Epic 4 flows
      // (auto-assign, pool/claim, manual assign) have realistic data on a fresh seed.
      const devRows = await tx
        .select({ id: s.users.id, email: s.users.email })
        .from(s.users)
        .where(inArray(s.users.email, devUsers.map((u) => u.email)));
      const byEmail = new Map(devRows.map((u) => [u.email, u.id]));
      const hrisId = byKey.get('hris')!;
      const hrisCats = await tx
        .select({ id: s.categories.id, nameEn: s.categories.nameEn })
        .from(s.categories)
        .where(eq(s.categories.projectId, hrisId));
      const Payroll = hrisCats.find((c) => c.nameEn === 'Payroll')?.id;
      const Leave = hrisCats.find((c) => c.nameEn === 'Leave')?.id;
      const memberId = byEmail.get('member@dev.local');
      const leadId = byEmail.get('lead@dev.local');
      if (Payroll && Leave && memberId && leadId) {
        for (const cat of [Payroll, Leave]) {
          for (const uid of [memberId, leadId]) {
            await tx
              .insert(s.userGroupMembership)
              .values({ userId: uid, categoryId: cat })
              .onConflictDoNothing();
          }
        }
        // Payroll → round-robin [lead, member]; Leave is left config-less → pooled
        // (so the "Pool nhóm" + claim flow has tickets to act on).
        await tx
          .insert(s.autoAssignConfig)
          .values({ categoryId: Payroll, strategy: 'round_robin' })
          .onConflictDoNothing({ target: s.autoAssignConfig.categoryId });
        const [cfg] = await tx
          .select({ id: s.autoAssignConfig.id })
          .from(s.autoAssignConfig)
          .where(eq(s.autoAssignConfig.categoryId, Payroll));
        if (cfg) {
          await tx
            .insert(s.autoAssignMembers)
            .values({ configId: cfg.id, userId: leadId, position: 0 })
            .onConflictDoNothing();
          await tx
            .insert(s.autoAssignMembers)
            .values({ configId: cfg.id, userId: memberId, position: 1 })
            .onConflictDoNothing();
        }
      }
    }
  });

  console.log('seed complete');
}

if (require.main === module) {
  seedOnce()
    .then(async () => {
      await sql.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('seed failed', err);
      await sql.end();
      process.exit(1);
    });
}
