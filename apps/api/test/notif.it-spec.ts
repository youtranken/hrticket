import { eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { notifications } from '../src/infra/db/schema';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const session = (id: string, email: string): SessionUser => ({
  id,
  email,
  name: email,
  role: 'member',
  projectId: 1,
  disabled: false,
  mustChangePassword: false,
});

/**
 * IT-NOTIF-001/002 — Story 6.1. The bell list is a delta (since-filtered) with an
 * unread count + mark-read, and RLS makes notifications strictly per-recipient: user
 * B never sees or mutates user A's, even calling the service directly. Needs Docker.
 */
describe('IT-NOTIF: in-app notifications', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new NotificationsService();
  let A: SessionUser;
  let B: SessionUser;

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const a = (await makeUser(harness.db, { projectId: 1, email: 'a-notif@x.com' }))!;
      const b = (await makeUser(harness.db, { projectId: 1, email: 'b-notif@x.com' }))!;
      A = session(a.id, a.email);
      B = session(b.id, b.email);
      ready = true;
    } catch (e) {
      console.warn('[IT-NOTIF] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (!ready) return;
    await harness!.db.delete(notifications);
  });

  const seed = (actorId: string, type: string) =>
    harness!.db.insert(notifications).values({ actorId, type, payload: JSON.stringify({ ticketId: 't' }) });

  it('IT-NOTIF-001: delta list + unread count + mark read', async () => {
    if (!ready) return;
    await seed(A.id, 'ticket_assigned');
    await seed(A.id, 'ticket_reopened');

    const first = await svc.list(A);
    expect(first.items).toHaveLength(2);
    expect(first.unreadCount).toBe(2);
    expect(first.latest).not.toBeNull();
    const watermark = first.latest!;

    // A new one a clear second later → the delta carries it (the boundary is
    // second-precision via Last-Modified, so use a >1s gap to be unambiguous).
    await new Promise((r) => setTimeout(r, 1100));
    await seed(A.id, 'snooze_due');
    const delta1 = await svc.list(A, watermark);
    expect(delta1.items.some((i) => i.type === 'snooze_due')).toBe(true);
    expect(delta1.unreadCount).toBe(3);

    // Re-watermarking past the newest leaves no further delta.
    const snapshot = await svc.list(A);
    const delta2 = await svc.list(A, new Date(snapshot.latest!.getTime() + 1000));
    expect(delta2.items).toHaveLength(0);

    // Mark one read → unread drops.
    const target = first.items[0]!.id;
    await svc.markRead(A, target);
    const after = await svc.list(A);
    expect(after.unreadCount).toBe(2);
    expect(after.items.find((i) => i.id === target)!.readAt).not.toBeNull();
  });

  it('IT-NOTIF-002: RLS — B never sees or mutates A\'s notifications', async () => {
    if (!ready) return;
    await seed(A.id, 'ticket_assigned');
    const [aRow] = await harness!.db.select().from(notifications).where(eq(notifications.actorId, A.id));
    await seed(B.id, 'ticket_reopened');

    const bList = await svc.list(B);
    expect(bList.items).toHaveLength(1);
    expect(bList.items[0]!.type).toBe('ticket_reopened'); // only B's

    // B tries to mark A's notification read → RLS makes it a no-op (A stays unread).
    await svc.markRead(B, aRow!.id);
    const [aAfter] = await harness!.db.select().from(notifications).where(eq(notifications.id, aRow!.id));
    expect(aAfter!.readAt).toBeNull();
  });
});
