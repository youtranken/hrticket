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
          .onConflictDoNothing();
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
