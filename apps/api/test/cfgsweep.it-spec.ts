import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { categories } from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';
import { ProjectContextService } from '../src/modules/auth/project-context.service';
import { SessionService } from '../src/modules/auth/session.service';
import { AdminConfigController } from '../src/modules/admin/admin-config.controller';
import { AdminConfigService } from '../src/modules/admin/admin-config.service';
import { AdminReminderController } from '../src/modules/admin/admin-reminder.controller';
import { AdminReminderService } from '../src/modules/admin/admin-reminder.service';
import { AdminMailBombController } from '../src/modules/admin/admin-mailbomb.controller';
import { AdminMailBombService } from '../src/modules/admin/admin-mailbomb.service';
import { AdminBlocklistController } from '../src/modules/admin/admin-blocklist.controller';
import { AdminBlocklistService } from '../src/modules/admin/admin-blocklist.service';
import { AdminJunkRulesController } from '../src/modules/admin/admin-junkrules.controller';
import { AdminJunkRulesService } from '../src/modules/admin/admin-junkrules.service';
import { AttachmentConfigController } from '../src/modules/admin/attachment-config.controller';
import { AttachmentConfigService } from '../src/modules/admin/attachment-config.service';
import { AdminGroupsController } from '../src/modules/admin/admin-groups.controller';
import { AdminGroupsService } from '../src/modules/admin/admin-groups.service';
import { AdminUsersController } from '../src/modules/auth/admin-users.controller';
import { AdminUsersService } from '../src/modules/auth/admin-users.service';
import { RescueService } from '../src/modules/auth/rescue.service';
import { RoleCapabilitiesController } from '../src/modules/ssa/role-capabilities.controller';
import { RoleCapabilitiesService } from '../src/modules/ssa/role-capabilities.service';
import { EmailConnectionController } from '../src/modules/admin/email-connection.controller';
import { EmailConnectionService } from '../src/modules/admin/email-connection.service';

/**
 * IT-CFGSWEEP-001/002 — Story 11.3 (FR93/FR94), the v1 acceptance sweep. Drives
 * EVERY config write endpoint through its real controller (the FR93 gate lives in
 * the controller's project()/assertAdmin / the service's SSA check):
 *  001 SCOPE: Member & Team Lead → 403; Admin → own project only (cross-project
 *      403); SSA → any project; the SSA-only matrix endpoint → Admin 403.
 *  002 AUDIT: every successful config write emits ≥1 audit_log row (FR94 — no
 *      silent change). A new config endpoint MUST be appended to OPS or it is
 *      silently uncovered. Needs Docker.
 */
describe('IT-CFGSWEEP: config scope + audit sweep', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  let leaveId = 0;
  let seq = 0;

  const projectCtx = new ProjectContextService();
  const sessions = new SessionService();
  const adminConfig = new AdminConfigController(new AdminConfigService(), projectCtx);
  const reminder = new AdminReminderController(new AdminReminderService(), projectCtx);
  const mailbomb = new AdminMailBombController(new AdminMailBombService(), projectCtx);
  const blocklist = new AdminBlocklistController(new AdminBlocklistService(), projectCtx);
  const junkrules = new AdminJunkRulesController(new AdminJunkRulesService(), projectCtx);
  const attachment = new AttachmentConfigController(new AttachmentConfigService(), projectCtx);
  const groups = new AdminGroupsController(new AdminGroupsService(), projectCtx);
  const users = new AdminUsersController(
    new RescueService(sessions),
    new AdminUsersService(sessions),
    projectCtx,
  );
  const roleCaps = new RoleCapabilitiesController(new RoleCapabilitiesService());
  const emailConn = new EmailConnectionController(new EmailConnectionService(), projectCtx);

  const ID = {
    member: '00000000-0000-0000-0000-0000000000a1',
    lead: '00000000-0000-0000-0000-0000000000a2',
    admin: '00000000-0000-0000-0000-0000000000a3',
    ssa: '00000000-0000-0000-0000-0000000000a4',
  };
  const sess = (id: string, projectId: number | null, role: SessionUser['role']): SessionUser => ({
    id,
    email: `${role}@sweep.local`,
    name: role,
    role,
    projectId,
    disabled: false,
    mustChangePassword: false,
  });
  // Member & Team Lead are refused before any write, so fake ids are fine. Admin &
  // SSA actually execute writes (some set a `created_by` FK), so they must be real
  // user rows — populated in beforeAll.
  const member = sess(ID.member, 1, 'member');
  const lead = sess(ID.lead, 1, 'team_lead');
  let adminH: SessionUser;
  let ssa: SessionUser;

  /** A config write op. `run` invokes the real controller with a schema-valid,
   *  HRIS-oriented payload (so the only failure mode under test is authorization). */
  interface Op {
    label: string;
    ssaOnly?: boolean;
    /** Endpoint scoped by the ACTOR's own project (rescue), not X-Project: skip the
     *  cross-project legs — member/lead → 403, admin/ssa on own project → allowed. */
    actorScoped?: boolean;
    run: (actor: SessionUser, xp?: string) => Promise<unknown>;
  }

  /** A throwaway member in HRIS to target with the per-user privileged ops. */
  const newMember = () => makeUser(harness!.db, { projectId: 1, role: 'member', email: `tgt-${++seq}@x.com` });

  const OPS: Op[] = [
    {
      label: 'config.createCategory',
      run: (a, xp) =>
        adminConfig.createCategory(a, { nameVi: `SV${++seq}`, nameEn: `SE${seq}`, isSensitive: false }, xp),
    },
    {
      label: 'reminder.putConfig',
      run: (a, xp) =>
        reminder.putConfig(a, { overdueDays: 3, digestHour: 8, digestEnabled: true, digestMaxN: 10 + (++seq % 30) }, xp),
    },
    {
      label: 'mailbomb.putConfig',
      run: (a, xp) => mailbomb.putConfig(a, { mailBombPerHour: 20 + (++seq % 40) }, xp),
    },
    {
      label: 'blocklist.add',
      run: (a, xp) => blocklist.add(a, { email: `bl-${++seq}@x.com`, reason: 'sweep' }, xp),
    },
    {
      label: 'junkrules.add',
      run: (a, xp) => junkrules.add(a, { kind: 'keyword', pattern: `sweep-${++seq}` }, xp),
    },
    {
      label: 'attachment.put',
      run: (a, xp) => attachment.put(a, { capMb: 100 + (++seq % 800) }, xp),
    },
    {
      label: 'groups.setMembers',
      run: async (a, xp) => {
        const u = (await makeUser(harness!.db, { projectId: 1, email: `grp-${++seq}@x.com` }))!;
        return groups.setMembers(a, String(leaveId), { userIds: [u.id] }, xp);
      },
    },
    {
      label: 'users.create',
      run: (a, xp) =>
        users.create(a, { email: `usr-${++seq}@x.com`, name: 'Sweep', role: 'member', categoryIds: [leaveId] }, xp),
    },
    {
      label: 'roleCaps.setCapability',
      ssaOnly: true,
      run: (a) => roleCaps.setCell(a, { role: 'member', capability: 'ticket.reply', allowed: true }),
    },
    {
      label: 'emailConnection.put',
      run: (a, xp) =>
        emailConn.put(
          a,
          { imapHost: 'h.local', imapPort: 993, imapUser: `u${++seq}@x.com`, smtpHost: 'h.local', smtpPort: 465, smtpUser: `u${seq}@x.com` },
          xp,
        ),
    },
    // ── privileged user mutations (the audit-gap class that finding #1 lived in) ──
    {
      label: 'users.setRole',
      run: async (a, xp) => {
        const u = (await newMember())!;
        return users.setRole(a, u.id, { role: 'member' }, xp);
      },
    },
    {
      label: 'users.setDisabled',
      run: async (a, xp) => {
        const u = (await newMember())!;
        return users.setDisabled(a, u.id, { disabled: true }, xp);
      },
    },
    {
      // reset-password is scoped by the actor's own project (rescue), not X-Project.
      label: 'users.resetPassword',
      actorScoped: true,
      run: async (a) => {
        const u = (await newMember())!;
        return users.resetPassword(a, u.id);
      },
    },
    {
      label: 'users.removeOtp',
      actorScoped: true,
      run: async (a) => {
        const u = (await newMember())!;
        return users.removeOtp(a, u.id);
      },
    },
    {
      label: 'roleCaps.restoreDefaults',
      ssaOnly: true,
      run: (a) => roleCaps.reset(a),
    },
  ];

  /** HTTP status of a controller call: 200 if it resolves, else the thrown code. */
  async function code(p: Promise<unknown>): Promise<number> {
    try {
      await p;
      return 200;
    } catch (e) {
      const err = e as { getStatus?: () => number; status?: number };
      if (typeof err?.getStatus === 'function') return err.getStatus();
      return err?.status ?? 500;
    }
  }

  /** Audit rows ATTRIBUTED to a specific actor — a global count(*) delta would pass
   *  an op that writes zero rows as long as any unrelated row appeared (the very gap
   *  that let finding #1's un-audited reset slip through). */
  async function auditCount(actorId: string): Promise<number> {
    const r = await harness!.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE actor_id = ${actorId}`,
    );
    return Number((r as unknown as Array<{ n: number }>)[0]!.n);
  }

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      leaveId = cats.find((c) => c.nameEn === 'Leave')!.id;
      const a = (await makeUser(harness.db, { projectId: 1, role: 'admin', email: 'sweep-admin@x.com' }))!;
      const s = (await makeUser(harness.db, { projectId: 1, role: 'ssa', email: 'sweep-ssa@x.com' }))!;
      adminH = sess(a.id, 1, 'admin');
      ssa = sess(s.id, null, 'ssa');
      ready = true;
    } catch (e) {
      console.warn('[IT-CFGSWEEP] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  // Jest's expect() takes no message arg — throw a labelled error so a failing
  // endpoint in the loop is identifiable.
  const is403 = (label: string, got: number): void => {
    if (got !== 403) throw new Error(`${label}: expected 403, got ${got}`);
  };
  const not403 = (label: string, got: number): void => {
    if (got === 403) throw new Error(`${label}: unexpected 403 (should be allowed)`);
  };
  // Stronger than not403 for the OWN-project positive leg: a broken-but-not-403
  // endpoint (e.g. a 500) must not masquerade as "allowed".
  const is2xx = (label: string, got: number): void => {
    if (got < 200 || got >= 300) throw new Error(`${label}: expected 2xx, got ${got}`);
  };

  it('IT-CFGSWEEP-001: FR93 scope matrix holds on every config endpoint', async () => {
    if (!ready) return;
    for (const op of OPS) {
      // Member & Team Lead are refused everywhere (config is admin/ssa only).
      is403(`${op.label}: member`, await code(op.run(member)));
      is403(`${op.label}: team_lead`, await code(op.run(lead)));

      if (op.ssaOnly) {
        // SSA-only matrix: even an Admin is refused at the API (not just the menu).
        is403(`${op.label}: admin (ssa-only)`, await code(op.run(adminH)));
        is2xx(`${op.label}: ssa`, await code(op.run(ssa)));
      } else if (op.actorScoped) {
        // Scoped by the actor's own project (rescue) — no X-Project leg.
        is2xx(`${op.label}: admin home`, await code(op.run(adminH)));
        is2xx(`${op.label}: ssa`, await code(op.run(ssa)));
      } else {
        // Admin → own project allowed; a cross-project header is refused (FR93).
        is2xx(`${op.label}: admin home`, await code(op.run(adminH)));
        is403(`${op.label}: admin cross-project`, await code(op.run(adminH, 'cnb')));
        // SSA → either project. (Cross-project payload may not be 2xx-clean for ops
        // that reference an HRIS-only id, so only assert "not refused" here.)
        not403(`${op.label}: ssa hris`, await code(op.run(ssa, 'hris')));
        not403(`${op.label}: ssa cnb`, await code(op.run(ssa, 'cnb')));
      }
    }
    expect(OPS.length).toBeGreaterThanOrEqual(15);
  });

  it('IT-CFGSWEEP-002: every successful config write emits an audit row (FR94)', async () => {
    if (!ready) return;
    for (const op of OPS) {
      const actor = op.ssaOnly ? ssa : adminH;
      const xp = op.ssaOnly || op.actorScoped ? undefined : 'hris';
      const before = await auditCount(actor.id);
      await op.run(actor, xp); // must succeed for an Admin/SSA on their own project
      const after = await auditCount(actor.id);
      if (after <= before) throw new Error(`${op.label} wrote no audit row attributed to ${actor.role}`);
    }
    expect(true).toBe(true);
  });
});
