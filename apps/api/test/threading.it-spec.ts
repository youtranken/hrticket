import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { and, eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { AppModule } from '../src/app.module';

import { makeRaw, seedInbox } from './helpers/mail-raw';
import { IntakeService } from '../src/modules/intake/intake.service';
import {
  inboxMessages,
  tickets,
  ticketMessages,
  participants,
  projectCounters,
  outbox,
} from '../src/infra/db/schema';

/**
 * IT-THREAD-001..004 — Story 2.3: inbound threading + anti-spoof + stranger approval.
 */
describe('IT-THREAD: inbound threading', () => {
  let harness: ItHarness | undefined;
  let app: INestApplication | undefined;
  let intake: IntakeService;
  let ready = false;
  const HRIS = 1;
  const CNB = 2;
  const HRIS_BOX = 'hris@test.local';
  const CNB_BOX = 'cnb@test.local';

  const tall = () => harness!.db.select().from(tickets);

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();
      intake = new IntakeService();
      ready = true;
    } catch (e) {
      console.warn('[IT-THREAD] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.stop();
  });

  beforeEach(async () => {
    if (ready) {
      await harness!.db.delete(participants);
      await harness!.db.delete(ticketMessages);
      await harness!.db.delete(inboxMessages);
      await harness!.db.delete(outbox); // auto-ack rows FK→tickets; clear before tickets
      await harness!.db.delete(tickets);
      await harness!.db.update(projectCounters).set({ lastNo: 0 });
    }
  });

  it('IT-THREAD-001: In-Reply-To header appends to the same ticket', async () => {
    if (!ready) return;
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'a@x.com', to: HRIS_BOX, subject: 'Q', messageId: '<orig@x.com>' }), '<orig@x.com>');
    await intake.processReceived();
    const [t] = await tall();

    await seedInbox(
      harness!.db,
      HRIS,
      HRIS_BOX,
      makeRaw({ from: 'a@x.com', to: HRIS_BOX, subject: 'Re: Q', messageId: '<reply@x.com>', inReplyTo: '<orig@x.com>' }),
      '<reply@x.com>',
    );
    await intake.processReceived();

    expect(await tall()).toHaveLength(1); // no new ticket
    const msgs = await harness!.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, t!.id), eq(ticketMessages.direction, 'inbound')));
    expect(msgs).toHaveLength(2); // original + reply append (auto-ack outbound excluded)
  });

  it('IT-THREAD-002: subject code appends only for a participant; stranger → new ticket', async () => {
    if (!ready) return;
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'a@x.com', to: HRIS_BOX, subject: 'Orig', messageId: '<c2@x.com>' }), '<c2@x.com>');
    await intake.processReceived();
    const code = (await tall())[0]!.ticketCode; // #00001

    // participant a@x.com with [#code] in subject, no header → append
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'a@x.com', to: HRIS_BOX, subject: `[${code}] more`, messageId: '<c2-p@x.com>' }), '<c2-p@x.com>');
    // stranger with same [#code] → must NOT join; new ticket
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'z@evil.com', to: HRIS_BOX, subject: `[${code}] spoof`, messageId: '<c2-s@x.com>' }), '<c2-s@x.com>');
    await intake.processReceived();

    const all = await tall();
    expect(all).toHaveLength(2); // original + stranger's new ticket
    const orig = all.find((t) => t.ticketCode === code)!;
    const msgs = await harness!.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, orig.id), eq(ticketMessages.direction, 'inbound')));
    expect(msgs).toHaveLength(2); // original + participant's append (not the spoof; auto-ack excluded)
  });

  it('IT-THREAD-003: a subject code from another project does not match', async () => {
    if (!ready) return;
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'a@x.com', to: HRIS_BOX, subject: 'hris one', messageId: '<c3@x.com>' }), '<c3@x.com>');
    await intake.processReceived();
    const hrisCode = (await tall())[0]!.ticketCode; // #00001 in hris

    // Same code, but the mail arrives in CNB and From is a@x.com.
    await seedInbox(harness!.db, CNB, CNB_BOX, makeRaw({ from: 'a@x.com', to: CNB_BOX, subject: `[${hrisCode}] cross`, messageId: '<c3-cnb@x.com>' }), '<c3-cnb@x.com>');
    await intake.processReceived();

    const all = await tall();
    expect(all).toHaveLength(2); // hris original + a NEW cnb ticket
    expect(all.filter((t) => t.projectId === CNB)).toHaveLength(1);
  });

  it('IT-THREAD-004: a first-seen address on a reply joins as ACTIVE (approval removed)', async () => {
    if (!ready) return;
    await seedInbox(harness!.db, HRIS, HRIS_BOX, makeRaw({ from: 'a@x.com', to: HRIS_BOX, subject: 'Orig', messageId: '<c4@x.com>' }), '<c4@x.com>');
    await intake.processReceived();
    const [t] = await tall();

    // A new address replies in-thread → admitted ACTIVE right away: the next
    // reply-all includes them with no human approval step (feature removed).
    await seedInbox(
      harness!.db,
      HRIS,
      HRIS_BOX,
      makeRaw({ from: 'c@y.com', to: HRIS_BOX, subject: 'Re: Orig', messageId: '<c4-r@x.com>', inReplyTo: '<c4@x.com>' }),
      '<c4-r@x.com>',
    );
    await intake.processReceived();

    const [newcomer] = await harness!.db
      .select()
      .from(participants)
      .where(and(eq(participants.ticketId, t!.id), eq(participants.email, 'c@y.com')));
    expect(newcomer!.status).toBe('active');
  });
});
