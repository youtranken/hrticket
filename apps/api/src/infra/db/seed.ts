import * as argon2 from 'argon2';
import { db, sql } from './db';
import * as s from './schema';

/**
 * Idempotent seed: 2 projects, 6 default categories/project (bilingual),
 * role_capabilities per the PRD §2 matrix, project_counters=0, reminder_config
 * + project_settings defaults, email_connections from env, and the first SSA.
 * Re-running does not duplicate (ON CONFLICT DO NOTHING).
 */

const DEFAULT_CATEGORIES: Array<{ vi: string; en: string; system?: boolean; sensitive?: boolean }> =
  [
    { vi: 'Chấm công', en: 'Attendance' },
    { vi: 'Nghỉ phép', en: 'Leave' },
    { vi: 'OT', en: 'Overtime' },
    { vi: 'Lương', en: 'Payroll', sensitive: true },
    { vi: 'Bảo hiểm', en: 'Insurance', sensitive: true },
    { vi: 'Khác', en: 'Other', system: true },
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
      'Chào {{requesterName}},\n\nChúng tôi đã tiếp nhận yêu cầu "{{subject}}" và tạo phiếu mã {{ticketCode}}.\nVui lòng trả lời ngay trên email này (giữ nguyên mã {{ticketCode}} ở tiêu đề) nếu cần bổ sung thông tin.\n\nTrân trọng,\nBộ phận Nhân sự',
    bodyEn:
      'Hi {{requesterName}},\n\nWe have received your request "{{subject}}" and opened ticket {{ticketCode}}.\nPlease reply directly to this email (keep {{ticketCode}} in the subject) if you have anything to add.\n\nBest regards,\nHR Team',
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
      const devHash = await argon2.hash(devPassword, { type: argon2.argon2id });
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
            passwordHash: devHash,
            role: u.role,
            mustChangePassword: false,
          })
          .onConflictDoNothing({ target: s.users.email });
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
