import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { categories, categoryKeywords, tickets, ticketTags, tags, projectSettings } from '../src/infra/db/schema';
import { classifyTicket } from '../src/modules/routing/classify.service';
import { applyAutoTags } from '../src/modules/routing/auto-tag.service';

/**
 * IT-ROUTE-001/002 — Story 4.1. Keyword classification matrix (1 / many / none /
 * accent-insensitive) and signal + priority-keyword auto-tagging. Pure DB on the
 * seeded harness (categories + keywords + tags). Needs Docker; self-skips.
 */
describe('IT-ROUTE: keyword classify + auto-tag', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const PROJECT = 1;
  let catId: Map<string, number>;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const rows = await harness.db
        .select({ id: categories.id, nameEn: categories.nameEn })
        .from(categories)
        .where(eq(categories.projectId, PROJECT));
      catId = new Map(rows.map((r) => [r.nameEn, r.id]));
      ready = true;
    } catch (e) {
      console.warn('[IT-ROUTE] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  async function classify(subject: string, body: string) {
    return withActor(systemActor, (tx) => classifyTicket(tx, PROJECT, subject, body));
  }

  it('IT-ROUTE-001: classify matrix — single / multi / none / accent-insensitive', async () => {
    if (!ready) return;
    const Leave = catId.get('Leave')!;
    const Payroll = catId.get('Payroll')!;
    const Other = catId.get('Other')!;

    // Single match.
    const single = await classify('Xin nghỉ phép ngày mai', 'cần duyệt giúp');
    expect(single.categoryId).toBe(Leave);
    expect(single.reason).toBe('single_match');
    expect(single.matchedKeywords.length).toBeGreaterThan(0);

    // Accent-insensitive: "nghi phep" must still hit Leave.
    const noAccent = await classify('nghi phep thang sau', '');
    expect(noAccent.categoryId).toBe(Leave);

    // Body-only match (scan covers Subject + Body).
    const bodyOnly = await classify('Câu hỏi', 'Cho mình hỏi về bảng lương tháng này');
    expect(bodyOnly.categoryId).toBe(Payroll);

    // Multiple categories matched → Other (ambiguous never guessed).
    const multi = await classify('Nghỉ phép và lương', 'hỏi cả hai');
    expect(multi.categoryId).toBe(Other);
    expect(multi.reason).toBe('multi_match');

    // No keyword → Other.
    const none = await classify('Linh tinh vu vơ', 'không liên quan gì cả');
    expect(none.categoryId).toBe(Other);
    expect(none.reason).toBe('no_match');
  });

  it('IT-ROUTE-002: auto-tag signals + priority keyword rule + per-project toggle', async () => {
    if (!ready) return;

    // A throwaway ticket to tag (direct insert bypasses RLS as the owner connection).
    const mkTicket = async (subject: string): Promise<string> => {
      const [row] = await harness!.db
        .insert(tickets)
        .values({
          projectId: PROJECT,
          ticketCode: `#R${Math.floor(Math.random() * 90000) + 10000}`,
          subject,
          requesterEmail: 'req@x.com',
          mailbox: 'hris@test.local',
          categoryId: catId.get('Other')!,
          status: 'open',
        })
        .returning({ id: tickets.id });
      return row!.id;
    };
    const tagsOf = async (ticketId: string): Promise<string[]> =>
      (
        await harness!.db
          .select({ name: tags.name })
          .from(ticketTags)
          .innerJoin(tags, eq(tags.id, ticketTags.tagId))
          .where(eq(ticketTags.ticketId, ticketId))
      ).map((r) => r.name);

    // All three signal tags + a priority keyword ("khẩn") in the subject.
    const t1 = await mkTicket('Việc này rất khẩn, cần xử lý gấp');
    const applied = await withActor(systemActor, (tx) =>
      applyAutoTags(tx, {
        projectId: PROJECT,
        ticketId: t1,
        subject: 'Việc này rất khẩn, cần xử lý gấp',
        body: 'có đính kèm',
        signals: { hasStoredAttachment: true, isAutoReply: true, isCrossPost: true },
      }),
    );
    expect(new Set(applied)).toEqual(
      new Set(['Attachment', 'Auto-reply', 'Cross-post', 'Ưu tiên cao']),
    );
    expect(new Set(await tagsOf(t1))).toEqual(
      new Set(['Attachment', 'Auto-reply', 'Cross-post', 'Ưu tiên cao']),
    );

    // No priority keyword → no priority tag; only the attachment signal.
    const t2 = await mkTicket('Câu hỏi bình thường');
    await withActor(systemActor, (tx) =>
      applyAutoTags(tx, {
        projectId: PROJECT,
        ticketId: t2,
        subject: 'Câu hỏi bình thường',
        body: 'không có gì',
        signals: { hasStoredAttachment: true },
      }),
    );
    expect(await tagsOf(t2)).toEqual(['Attachment']);

    // Per-project toggle off → the Attachment signal is suppressed.
    await harness!.db
      .update(projectSettings)
      .set({ autotagAttachment: false })
      .where(eq(projectSettings.projectId, PROJECT));
    const t3 = await mkTicket('Toggle off');
    const off = await withActor(systemActor, (tx) =>
      applyAutoTags(tx, {
        projectId: PROJECT,
        ticketId: t3,
        subject: 'Toggle off',
        body: '',
        signals: { hasStoredAttachment: true },
      }),
    );
    expect(off).toEqual([]);
    expect(await tagsOf(t3)).toEqual([]);
    await harness!.db
      .update(projectSettings)
      .set({ autotagAttachment: true })
      .where(eq(projectSettings.projectId, PROJECT));
  });

  it('IT-ROUTE-003: keyword matches whole words only, not substrings (P9)', async () => {
    if (!ready) return;
    const [wb] = await harness!.db
      .insert(categories)
      .values({ projectId: PROJECT, nameVi: 'WB', nameEn: 'WBTest' })
      .returning({ id: categories.id });
    await harness!.db.insert(categoryKeywords).values({ categoryId: wb!.id, keyword: 'zzk' });

    // Whole word → matches the category.
    const whole = await classify('Ma zzk hop le', '');
    expect(whole.categoryId).toBe(wb!.id);
    expect(whole.reason).toBe('single_match');

    // Substring inside a longer word → does NOT match → "Khác"/Other (P9).
    const inside = await classify('Chuoi zzkx khong khop', '');
    expect(inside.categoryId).toBe(catId.get('Other')!);
    expect(inside.reason).toBe('no_match');
  });
});
