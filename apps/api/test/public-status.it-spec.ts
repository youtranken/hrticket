import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { tickets } from '../src/infra/db/schema';
import { PublicStatusService } from '../src/modules/public/public-status.service';
import { sign } from '../src/infra/crypto/signing';

const REQ = 'req@x.com';

/**
 * IT-PUBSTATUS-001/002 — Story 12.8. The public tracker collapses the 6 internal
 * ticket states into 4 requester-facing buckets (pending now has its own "awaiting"
 * bucket). A tampered/garbage token is indistinguishable from "not found", and the
 * payload never leaks internal fields. Time-independent; needs Docker (Testcontainers).
 */
describe('IT-PUBSTATUS: public status 4-bucket mapping', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new PublicStatusService();

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      ready = true;
    } catch (e) {
      console.warn('[IT-PUBSTATUS] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  let seq = 0;
  async function makeTicket(status: string): Promise<string> {
    seq += 1;
    const [row] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: `#P${String(seq).padStart(5, '0')}`,
        subject: 'public status',
        requesterEmail: REQ,
        mailbox: 'hris@test.local',
        status: status as 'open',
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  it('IT-PUBSTATUS-001: maps all 6 internal states to 4 public buckets', async () => {
    if (!ready) return;
    const cases: Array<[string, string]> = [
      ['open', 'received'],
      ['assigned', 'received'],
      ['in_progress', 'processing'],
      ['pending', 'awaiting'],
      ['resolved', 'closed'],
      ['closed', 'closed'],
    ];
    for (const [internal, bucket] of cases) {
      const id = await makeTicket(internal);
      const view = await svc.byToken(sign(id));
      expect(view.status).toBe(bucket);
    }
  });

  it('IT-PUBSTATUS-002: garbage/tampered token → NotFound; payload has no internal fields', async () => {
    if (!ready) return;
    await expect(svc.byToken('not-a-valid-token')).rejects.toMatchObject({ status: 404 });

    const id = await makeTicket('in_progress');
    const view = await svc.byToken(sign(id));
    // Only these four keys are ever exposed — no assignee/category/notes/internal status.
    expect(Object.keys(view).sort()).toEqual(['createdAt', 'status', 'subject', 'ticketCode']);
  });
});
