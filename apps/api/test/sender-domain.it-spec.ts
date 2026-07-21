import { and, eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import {
  inboxMessages,
  tickets,
  ticketMessages,
  participants,
  outbox,
  categories,
  categorySenderRules,
  junkRules,
  projectCounters,
} from '../src/infra/db/schema';
import { IntakeService } from '../src/modules/intake/intake.service';
import { AdminConfigService } from '../src/modules/admin/admin-config.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const admin: SessionUser = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'sdr-admin@x.com',
  name: 'sdr admin',
  role: 'admin',
  projectId: 1,
  disabled: false,
  mustChangePassword: false,
};

function makeRaw(o: { from: string; to: string; subject: string; text: string; messageId: string }): string {
  return [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Message-ID: ${o.messageId}`,
    'Date: Wed, 11 Jun 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.text,
    '',
  ].join('\r\n');
}

/**
 * IT-SDR-001/002/003 — Story 4.7 (FR104). Sender-domain routing as the safety net that
 * replaces "Khác": keyword single_match still wins; a would-be-"Khác" mail from a known
 * company domain lands in that company's pool; exact address beats glob; junk beats domain;
 * config CRUD enforces per-project uniqueness + "@"/system guards. Needs Docker; self-skips.
 */
describe('IT-SDR: sender-domain routing', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new AdminConfigService();
  const intake = new IntakeService();
  const HRIS = 1;
  const BOX = 'hris@test.local';
  let Other: number;
  let Payroll: number;
  let PHT: number; // company pool, glob rules *@phth.com + *@phth.com.vn
  let Board: number; // exact rule sep@phth.com (beats the PHT glob)

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const realAdmin = (await makeUser(harness.db, { projectId: HRIS, role: 'admin', email: 'sdr-admin@x.com' }))!;
      admin.id = realAdmin.id;
      const cats = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, HRIS));
      Other = cats.find((c) => c.nameEn === 'Other')!.id;
      Payroll = cats.find((c) => c.nameEn === 'Payroll')!.id;
      PHT = (
        await svc.createCategory(admin, HRIS, {
          nameVi: 'Phú Hưng Thịnh',
          nameEn: 'PHT',
          senderPatterns: ['*@phth.com', '*@phth.com.vn'],
        })
      ).id;
      Board = (
        await svc.createCategory(admin, HRIS, {
          nameVi: 'Ban Giám đốc',
          nameEn: 'Board',
          senderPatterns: ['sep@phth.com'],
        })
      ).id;
      ready = true;
    } catch (e) {
      console.warn('[IT-SDR] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(participants);
    await harness!.db.delete(ticketMessages);
    await harness!.db.delete(inboxMessages);
    await harness!.db.delete(outbox);
    await harness!.db.delete(tickets);
    await harness!.db.delete(junkRules);
    await harness!.db.update(projectCounters).set({ lastNo: 0 });
  });

  /** Seed one raw mail, run the full pipeline, return the ticket for THIS mail (by subject). */
  async function routeOne(o: { from: string; subject: string; text: string; messageId: string }) {
    await harness!.db
      .insert(inboxMessages)
      .values({ projectId: HRIS, mailbox: BOX, messageId: o.messageId, raw: makeRaw({ ...o, to: BOX }) });
    await intake.processReceived();
    return (await harness!.db.select().from(tickets).where(eq(tickets.subject, o.subject)))[0]!;
  }

  it('IT-SDR-001: DOMAIN-PRIMARY — domain decides, keyword only as fallback, exact>glob, multi-domain', async () => {
    if (!ready) return;
    // Distinct subjects so each sub-case reads its own ticket (no inter-case deletes → no
    // FK churn with participants). "zzq/aa/cc…" are neutral, non-keyword tokens.

    // (a) Domain matches → the company pool (companies are the categories now).
    const a = await routeOne({ from: 'an@phth.com', subject: 'zzq aa', text: 'nothing relevant here', messageId: '<sdr-a@x.com>' });
    expect(a.categoryId).toBe(PHT);

    // (b) DOMAIN beats keyword: same domain, subject carries the Payroll keyword "luong" —
    //     still routes to the company (domain-primary), NOT Payroll.
    const b = await routeOne({ from: 'an@phth.com', subject: 'zzq bb luong', text: 'bang luong thang nay', messageId: '<sdr-b@x.com>' });
    expect(b.categoryId).toBe(PHT);

    // (c) NO domain rule → keyword classification is the FALLBACK ("luong" → Payroll).
    const c = await routeOne({ from: 'someone@gmail.com', subject: 'zzq cc luong', text: 'bang luong', messageId: '<sdr-c@x.com>' });
    expect(c.categoryId).toBe(Payroll);

    // (d) NO domain + no keyword → "Khác"/Other (unchanged catch-all).
    const d = await routeOne({ from: 'someone@gmail.com', subject: 'zzq dd', text: 'nothing relevant', messageId: '<sdr-d@x.com>' });
    expect(d.categoryId).toBe(Other);

    // (e) Exact address beats the glob (most-specific wins).
    const e = await routeOne({ from: 'sep@phth.com', subject: 'zzq ee', text: 'nothing relevant', messageId: '<sdr-e@x.com>' });
    expect(e.categoryId).toBe(Board);

    // (f) A second domain of the same company → same pool.
    const f = await routeOne({ from: 'an@phth.com.vn', subject: 'zzq ff', text: 'nothing relevant', messageId: '<sdr-f@x.com>' });
    expect(f.categoryId).toBe(PHT);
  });

  it('IT-SDR-002: junk beats domain routing', async () => {
    if (!ready) return;
    // A junk sender rule that also matches the company domain.
    await harness!.db.insert(junkRules).values({ projectId: HRIS, kind: 'sender', pattern: 'spam@*' });

    const t = await routeOne({ from: 'spam@phth.com', subject: 'zzq hello', text: 'nothing relevant', messageId: '<sdr-junk@x.com>' });
    // Junk stage runs BEFORE intake domain-routing → forced to "Khác", flagged junk.
    expect(t.isJunk).toBe(true);
    expect(t.categoryId).toBe(Other);
    expect(t.categoryId).not.toBe(PHT);
  });

  it('IT-SDR-003: config CRUD — unique per project (409), "@"/system guards (422/403), list reflects', async () => {
    if (!ready) return;

    // Create two categories claiming the SAME pattern → second is rejected (unique per project).
    const confA = await svc.createCategory(admin, HRIS, { nameVi: 'CA', nameEn: 'ConfA', senderPatterns: ['*@conf.com'] });
    await expect(
      svc.createCategory(admin, HRIS, { nameVi: 'CB', nameEn: 'ConfB', senderPatterns: ['*@conf.com'] }),
    ).rejects.toThrow(/already routes/i);

    // Structurally-invalid patterns → 422: no "@", the catch-all "*@*" (would hijack all
    // routing), empty local part, empty domain.
    for (const bad of ['no-at-sign', '*@*', '@x.com', 'an@']) {
      await expect(
        svc.updateCategory(admin, HRIS, confA.id, { senderPatterns: [bad] }),
      ).rejects.toThrow();
    }

    // The system category "Khác" cannot take rules (it's immutable → 403).
    await expect(
      svc.updateCategory(admin, HRIS, Other, { senderPatterns: ['*@khac.com'] }),
    ).rejects.toThrow();

    // Patterns are lowercased + surface in listCategories.
    await svc.updateCategory(admin, HRIS, confA.id, { senderPatterns: ['*@MixedCase.com'] });
    const view = (await svc.listCategories(HRIS)).find((c) => c.id === confA.id)!;
    expect(view.senderPatterns).toEqual(['*@mixedcase.com']);

    // Cleanup this test's throwaway category so re-runs stay idempotent.
    await harness!.db.delete(categorySenderRules).where(eq(categorySenderRules.categoryId, confA.id));
    await harness!.db
      .delete(categories)
      .where(and(eq(categories.projectId, HRIS), eq(categories.id, confA.id)));
  });

  it('IT-SDR-004: a DISABLED company releases its domain — a new company can take it over', async () => {
    if (!ready) return;
    const A = await svc.createCategory(admin, HRIS, { nameVi: 'TakeA', nameEn: 'TakeA', senderPatterns: ['*@take.com'] });
    const B = await svc.createCategory(admin, HRIS, { nameVi: 'TakeB', nameEn: 'TakeB' });

    // While A is ACTIVE, B cannot claim A's domain (409).
    await expect(
      svc.updateCategory(admin, HRIS, B.id, { senderPatterns: ['*@take.com'] }),
    ).rejects.toThrow(/already routes/i);

    // Disable A → its rule is inert → B reclaims the domain (the dead rule is dropped).
    await svc.updateCategory(admin, HRIS, A.id, { disabled: true });
    await svc.updateCategory(admin, HRIS, B.id, { senderPatterns: ['*@take.com'] });

    const aView = (await svc.listCategories(HRIS)).find((c) => c.id === A.id)!;
    expect(aView.senderPatterns).not.toContain('*@take.com'); // A no longer owns it
    const bView = (await svc.listCategories(HRIS)).find((c) => c.id === B.id)!;
    expect(bView.senderPatterns).toContain('*@take.com');

    // Mail from the domain now routes to B.
    const t = await routeOne({ from: 'x@take.com', subject: 'zzq take', text: 'nothing', messageId: '<sdr-take@x.com>' });
    expect(t.categoryId).toBe(B.id);
    // No category cleanup: TakeA/TakeB names are unique to this test and the suite runs on a
    // fresh Testcontainers DB each run (and B is now referenced by the routed ticket via FK).
  });
});
