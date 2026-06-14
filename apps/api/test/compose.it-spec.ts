import { and, eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { NotesService } from '../src/modules/tickets/notes.service';
import { DraftsService } from '../src/modules/tickets/drafts.service';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { tickets, ticketMessages, outbox, drafts, users } from '../src/infra/db/schema';
import type { SessionUser } from '../src/modules/auth/session.service';

/**
 * IT-NOTE-001/002 + IT-DRAFT-001 — Stories 3.4/3.5. Internal notes never leave the
 * system (no outbox), and drafts are strictly per-user (RLS). Needs Docker; self-skips.
 */
describe('IT-NOTE/DRAFT: internal note + per-user draft', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  let ssa: SessionUser;
  let admin: SessionUser;
  let member: SessionUser;
  const notesSvc = new NotesService();
  const draftsSvc = new DraftsService();

  beforeAll(async () => {
    process.env.SEED_DEV_USERS = 'true'; // member/admin/lead fixtures for the RLS checks
    try {
      harness = await startHarness({ seed: true });
      const all = await harness.db.select().from(users);
      const find = (email: string) => all.find((u) => u.email === email)!;
      const mk = (email: string, role: SessionUser['role']): SessionUser => ({
        id: find(email).id,
        email,
        name: find(email).name,
        role,
        projectId: 1,
        disabled: false,
        mustChangePassword: false,
      });
      ssa = mk('ssa@dev.local', 'ssa');
      admin = mk('admin@dev.local', 'admin');
      member = mk('member@dev.local', 'member');
      ready = true;
    } catch (e) {
      console.warn('[IT-NOTE] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(drafts);
    await harness!.db.delete(ticketMessages);
    await harness!.db.delete(outbox);
    await harness!.db.delete(tickets);
  });

  async function makeTicket(code = '#00001'): Promise<string> {
    return withActor(systemActor, async (tx) => {
      const [t] = await tx
        .insert(tickets)
        .values({
          projectId: 1,
          ticketCode: code,
          subject: 'Test',
          requesterEmail: 'req@x.com',
          mailbox: 'hris@test.local',
          status: 'open',
        })
        .returning({ id: tickets.id });
      return t!.id;
    });
  }

  it('IT-NOTE-001: a note is internal and produces NO outbox row', async () => {
    if (!ready) return;
    const id = await makeTicket();
    const before = (await harness!.db.select().from(outbox)).length;

    await notesSvc.addNote(ssa, id, 'salary band 5 for A — internal only');

    const msgs = await harness!.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.isInternal).toBe(true);
    expect(msgs[0]!.toAddrs).toBeNull();
    expect((await harness!.db.select().from(outbox)).length).toBe(before); // nothing queued
  });

  it('IT-NOTE-002: a user who cannot see the ticket cannot note it (RLS)', async () => {
    if (!ready) return;
    const id = await makeTicket('#00002');
    // member has no group membership → ticket invisible → looks absent (404).
    await expect(notesSvc.addNote(member, id, 'should fail')).rejects.toThrow();
  });

  it('IT-DRAFT-001: upsert + get + delete; another user cannot read my draft (RLS)', async () => {
    if (!ready) return;
    const id = await makeTicket('#00003');

    await draftsSvc.put(ssa, id, 'reply', { body: 'draft v1', recipients: { to: ['a@x.com'] } });
    await draftsSvc.put(ssa, id, 'reply', { body: 'draft v2' }); // upsert, not duplicate
    const got = await draftsSvc.get(ssa, id, 'reply');
    expect(got?.body).toBe('draft v2');

    // Reply and note drafts are independent (AC4).
    await draftsSvc.put(ssa, id, 'note', { body: 'note draft' });
    expect((await draftsSvc.get(ssa, id, 'note'))?.body).toBe('note draft');
    expect((await draftsSvc.get(ssa, id, 'reply'))?.body).toBe('draft v2');

    // admin sees the ticket but must NOT see ssa's draft (per-user RLS).
    expect(await draftsSvc.get(admin, id, 'reply')).toBeNull();

    await draftsSvc.remove(ssa, id, 'reply');
    expect(await draftsSvc.get(ssa, id, 'reply')).toBeNull();
  });
});
