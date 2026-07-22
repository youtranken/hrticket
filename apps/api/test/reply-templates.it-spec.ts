import { eq, sql } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { categories, replyTemplates } from '../src/infra/db/schema';
import { ReplyTemplatesService } from '../src/modules/tickets/reply-templates.service';
import { ReplyTemplatesController } from '../src/modules/tickets/reply-templates.controller';
import type { ProjectContextService } from '../src/modules/auth/project-context.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const session = (id: string, email: string, role: SessionUser['role'], projectId: number | null): SessionUser => ({
  id,
  email,
  name: email,
  role,
  projectId,
  disabled: false,
  mustChangePassword: false,
});

/**
 * IT-TPL-001..004 — Story 12.2. Reply templates scope to a category (or common) and
 * can be soft-disabled: the composer list is category-filtered + enabled-only, the
 * manager list includes disabled rows, and a cross-project category is rejected.
 * Needs Docker.
 */
describe('IT-TPL: reply templates category scope + disable', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new ReplyTemplatesService();
  let PAYROLL = 0;
  let OTHER_CAT = 0; // another category in project 1
  let P2_CAT = 0; // a category in project 2 (cross-project)
  let ADMIN: SessionUser;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const c1 = await harness.db
        .select({ id: categories.id, en: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, 1));
      PAYROLL = c1.find((c) => c.en === 'Payroll')!.id;
      OTHER_CAT = c1.find((c) => c.en !== 'Payroll')!.id;
      const c2 = await harness.db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.projectId, 2));
      P2_CAT = c2[0]!.id;
      const a = (await makeUser(harness.db, { projectId: 1, email: 'adm-tpl@x.com', role: 'admin' }))!;
      ADMIN = session(a.id, a.email, 'admin', 1);
      ready = true;
    } catch (e) {
      console.warn('[IT-TPL] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  it('IT-TPL-001: composer list = category-matched + common, category-first; other category hidden', async () => {
    if (!ready) return;
    await svc.create(ADMIN, 1, { title: 'A-payroll', body: 'x', categoryId: PAYROLL });
    await svc.create(ADMIN, 1, { title: 'B-other', body: 'x', categoryId: OTHER_CAT });
    await svc.create(ADMIN, 1, { title: 'C-common', body: 'x', categoryId: null });

    const list = await svc.list(ADMIN, 1, { categoryId: PAYROLL });
    const titles = list.map((r) => r.title);
    expect(titles).toContain('A-payroll');
    expect(titles).toContain('C-common');
    expect(titles).not.toContain('B-other');
    // Category-specific before common.
    expect(titles.indexOf('A-payroll')).toBeLessThan(titles.indexOf('C-common'));
  });

  it('IT-TPL-002: disabled hidden from composer, shown in manager (includeDisabled)', async () => {
    if (!ready) return;
    const tpl = await svc.create(ADMIN, 1, { title: 'D-toggle', body: 'x', categoryId: PAYROLL });
    await svc.setEnabled(ADMIN, 1, tpl.id, false);

    const composer = await svc.list(ADMIN, 1, { categoryId: PAYROLL });
    expect(composer.map((r) => r.title)).not.toContain('D-toggle');

    const manager = await svc.list(ADMIN, 1, { includeDisabled: true });
    const row = manager.find((r) => r.title === 'D-toggle');
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(false);

    // Re-enable → back in the composer list.
    await svc.setEnabled(ADMIN, 1, tpl.id, true);
    const composer2 = await svc.list(ADMIN, 1, { categoryId: PAYROLL });
    expect(composer2.map((r) => r.title)).toContain('D-toggle');
  });

  it('IT-TPL-003: common (NULL) template shows for any category', async () => {
    if (!ready) return;
    await svc.create(ADMIN, 1, { title: 'E-common2', body: 'x', categoryId: null });
    const list = await svc.list(ADMIN, 1, { categoryId: OTHER_CAT });
    expect(list.map((r) => r.title)).toContain('E-common2');
  });

  it('IT-TPL-004: a cross-project category is rejected (422)', async () => {
    if (!ready) return;
    await expect(svc.create(ADMIN, 1, { title: 'F-bad', body: 'x', categoryId: P2_CAT })).rejects.toMatchObject({
      status: 422,
    });
  });

  it('IT-TPL-005: pre-migration rows (category NULL, enabled default) still list', async () => {
    if (!ready) return;
    // A row shaped like a template created BEFORE 12.2 (no category, enabled defaults true).
    await harness!.db
      .insert(replyTemplates)
      .values({ projectId: 1, title: 'H-legacy', body: 'x', createdBy: ADMIN.id });
    const composer = await svc.list(ADMIN, 1, { categoryId: PAYROLL });
    expect(composer.map((r) => r.title)).toContain('H-legacy'); // common + enabled by default
  });

  it('IT-TPL-006: toggle writes the right audit action (AC3); a plain member cannot mutate (AC6)', async () => {
    if (!ready) return;
    const tpl = await svc.create(ADMIN, 1, { title: 'G-audit', body: 'x', categoryId: PAYROLL });
    await svc.setEnabled(ADMIN, 1, tpl.id, false);
    await svc.setEnabled(ADMIN, 1, tpl.id, true);
    const rows = (await harness!.db.execute(
      sql`SELECT action FROM audit_log WHERE object_type = 'reply_template' AND object_id = ${String(tpl.id)}`,
    )) as unknown as Array<{ action: string }>;
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('reply_template.disabled');
    expect(actions).toContain('reply_template.enabled');

    // AC6: assertCanEdit runs first in the controller → a member is refused before any
    // project resolution, so a stub ProjectContextService is never touched.
    const controller = new ReplyTemplatesController(svc, {} as ProjectContextService);
    const member = session(ADMIN.id, 'member@x.com', 'member', 1);
    await expect(controller.setEnabled(member, String(tpl.id), { enabled: false }, 'hris')).rejects.toThrow();
    await expect(
      controller.update(member, String(tpl.id), { title: 'x', body: 'y' }, 'hris'),
    ).rejects.toThrow();
  });
});
