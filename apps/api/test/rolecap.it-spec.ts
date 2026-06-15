import { sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { RoleCapabilitiesService } from '../src/modules/ssa/role-capabilities.service';
import { RoleCapabilitiesController } from '../src/modules/ssa/role-capabilities.controller';
import type { SessionUser } from '../src/modules/auth/session.service';

/**
 * IT-ROLECAP-001/002 — Story 9.4 (FR55/FR72). SSA toggles the role × capability matrix
 * at runtime: a change is visible at once (cache busts, ≤60s), only SSA may edit (Admin
 * → 403), locked cells are refused even via a direct call, and "restore defaults" returns
 * to the PRD §2 matrix. Every edit is audited old→new. Needs Docker.
 */
describe('IT-ROLECAP: runtime role-capability editor', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new RoleCapabilitiesService();
  const controller = new RoleCapabilitiesController(svc);

  const session = (id: string, role: SessionUser['role']): SessionUser => ({
    id,
    email: `${id}@x.com`,
    name: id,
    role,
    projectId: 1,
    disabled: false,
    mustChangePassword: false,
  });
  let SSA: SessionUser;
  let ADMIN: SessionUser;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const ssaU = (await makeUser(harness.db, { projectId: 1, role: 'ssa', email: 'rc-ssa@x.com' }))!;
      const adminU = (await makeUser(harness.db, { projectId: 1, role: 'admin', email: 'rc-adm@x.com' }))!;
      SSA = session(ssaU.id, 'ssa');
      ADMIN = session(adminU.id, 'admin');
      ready = true;
    } catch (e) {
      console.warn('[IT-ROLECAP] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  afterEach(async () => {
    // Reset to defaults so each test starts from the PRD §2 matrix.
    if (ready) {
      await svc.restoreDefaults(SSA);
      await harness!.db.execute(sql`DELETE FROM audit_log WHERE action LIKE 'role_capability.%'`);
    }
  });

  it('IT-ROLECAP-001: toggle a capability on → effective at once → off; persisted + audited', async () => {
    if (!ready) return;
    // Default: Member cannot assign others.
    expect((await svc.getAllowed('member')).has('ticket.assign_others')).toBe(false);

    // SSA grants it → visible immediately (cache busted on write).
    await svc.setCapability(SSA, 'member', 'ticket.assign_others', true);
    expect((await svc.getAllowed('member')).has('ticket.assign_others')).toBe(true);
    // …and reflected in the editor matrix.
    const matrix = await svc.getMatrix();
    const row = matrix.rows.find((r) => r.capability === 'ticket.assign_others')!;
    expect(row.cells.find((c) => c.role === 'member')!.allowed).toBe(true);

    // SSA revokes it → gone again.
    await svc.setCapability(SSA, 'member', 'ticket.assign_others', false);
    expect((await svc.getAllowed('member')).has('ticket.assign_others')).toBe(false);

    // Both edits audited old→new (FR72).
    const audits = (await harness!.db.execute(sql`
      SELECT old_value->>'allowed' AS old, new_value->>'allowed' AS new
      FROM audit_log WHERE action = 'role_capability.changed' ORDER BY id
    `)) as unknown as Array<{ old: string; new: string }>;
    expect(audits).toEqual([
      { old: 'false', new: 'true' },
      { old: 'true', new: 'false' },
    ]);
  });

  it('IT-ROLECAP-002: only SSA edits (Admin→403) + locked cells refused even directly', async () => {
    if (!ready) return;
    // AC2 — Admin can neither read nor write the matrix (API gate, not just the menu).
    await expect(controller.getMatrix(ADMIN)).rejects.toMatchObject({ status: 403 });
    await expect(
      svc.setCapability(ADMIN, 'member', 'ticket.claim', false),
    ).rejects.toMatchObject({ status: 403 });

    // AC3 — locked cells (SSA self-edit power + full access) refuse a direct change…
    await expect(
      svc.setCapability(SSA, 'ssa', 'role.edit_capabilities', false),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      svc.setCapability(SSA, 'ssa', 'config.manage_all', false),
    ).rejects.toMatchObject({ status: 422 });
    // …and the matrix marks them locked (🔒) so the UI disables the switch.
    const matrix = await svc.getMatrix();
    const lockedCell = matrix.rows
      .find((r) => r.capability === 'role.edit_capabilities')!
      .cells.find((c) => c.role === 'ssa')!;
    expect(lockedCell).toMatchObject({ locked: true, allowed: true });

    // Unknown role / capability → 422 (not silently ignored).
    await expect(svc.setCapability(SSA, 'wizard', 'ticket.reply', true)).rejects.toMatchObject({ status: 422 });
    await expect(svc.setCapability(SSA, 'member', 'ticket.teleport', true)).rejects.toMatchObject({ status: 422 });
  });

  it('IT-ROLECAP-002b: restore defaults returns to PRD §2 + audits the reset', async () => {
    if (!ready) return;
    // Mutate a few cells away from default.
    await svc.setCapability(SSA, 'member', 'config.manage', true);
    await svc.setCapability(SSA, 'admin', 'config.manage', false);
    expect((await svc.getAllowed('member')).has('config.manage')).toBe(true);

    await svc.restoreDefaults(SSA);
    // Back to PRD §2: Member has none of config.manage; Admin has it.
    expect((await svc.getAllowed('member')).has('config.manage')).toBe(false);
    expect((await svc.getAllowed('admin')).has('config.manage')).toBe(true);
    expect((await svc.getAllowed('team_lead')).has('ticket.assign_others')).toBe(true);

    const [reset] = (await harness!.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_log WHERE action = 'role_capability.reset'
    `)) as unknown as Array<{ n: number }>;
    expect(Number(reset!.n)).toBeGreaterThanOrEqual(1);
  });
});
