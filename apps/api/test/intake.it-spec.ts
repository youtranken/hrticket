import { and, eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { withActor, systemActor } from '../src/infra/db/with-actor';
import { IntakeService } from '../src/modules/intake/intake.service';
import { createTicketFromMail } from '../src/modules/intake/create-ticket.usecase';
import { parseMail } from '../src/modules/email-engine/parser';
import {
  inboxMessages,
  tickets,
  ticketMessages,
  participants,
  categories,
  projectCounters,
  outbox,
} from '../src/infra/db/schema';

interface RawOpts {
  from: string;
  to: string;
  cc?: string;
  subject?: string;
  text?: string;
  messageId: string;
  date?: string;
}

function makeRaw(o: RawOpts): string {
  const lines = [
    `From: ${o.from}`,
    `To: ${o.to}`,
    o.cc ? `Cc: ${o.cc}` : '',
    `Subject: ${o.subject ?? 'subject'}`,
    `Message-ID: ${o.messageId}`,
    `Date: ${o.date ?? 'Wed, 11 Jun 2026 10:00:00 +0000'}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.text ?? 'body',
    '',
  ];
  return lines.filter((l, i) => l !== '' || i >= 7).join('\r\n');
}

/** Insert a raw mail straight into inbox_messages (status received), bypassing IMAP. */
async function seedInbox(db: ItHarness['db'], projectId: number, mailbox: string, raw: string, messageId: string) {
  const [row] = await db
    .insert(inboxMessages)
    .values({ projectId, mailbox, messageId, raw })
    .returning({ id: inboxMessages.id });
  return row!.id;
}

describe('IT-INTAKE: create ticket from mail', () => {
  let harness: ItHarness | undefined;
  let intake: IntakeService;
  let ready = false;
  const HRIS = 1;
  const BOX = 'hris@test.local';

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      intake = new IntakeService();
      ready = true;
    } catch (e) {
      console.warn('[IT-INTAKE] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 120000);

  afterAll(async () => {
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

  it('IT-INTAKE-001: new mail → one Open pooled ticket with full data', async () => {
    if (!ready) return;
    const raw = makeRaw({
      from: 'a@x.com',
      to: BOX,
      cc: 'b@x.com',
      subject: 'Hỏi nghỉ phép',
      text: 'Cho em hỏi nghỉ phép',
      messageId: '<i1@x.com>',
    });
    await seedInbox(harness!.db, HRIS, BOX, raw, '<i1@x.com>');

    const n = await intake.processReceived();
    expect(n).toBe(1);

    const t = (await harness!.db.select().from(tickets))[0]!;
    expect(t.status).toBe('open');
    expect(t.assigneeId).toBeNull();
    expect(t.ticketCode).toBe('#00001');
    expect(t.requesterEmail).toBe('a@x.com');
    // Classification is now live (Story 4.1): "nghỉ phép" routes to Leave, not the
    // old "always Other" stub. Ticket is still pooled (assignee null) until 4.2.
    const leave = (await harness!.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.projectId, HRIS), eq(categories.nameEn, 'Leave'))))[0]!;
    expect(t.categoryId).toBe(leave.id);

    const msgs = await harness!.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, t.id), eq(ticketMessages.direction, 'inbound')));
    expect(msgs).toHaveLength(1); // 1 inbound (the auto-ack is a separate outbound message)
    expect(msgs[0]!.direction).toBe('inbound');
    expect(msgs[0]!.ccAddrs).toEqual(['b@x.com']);

    const ppl = await harness!.db.select().from(participants).where(eq(participants.ticketId, t.id));
    expect(new Set(ppl.map((p) => p.email))).toEqual(new Set(['a@x.com', 'b@x.com']));

    const inbox = await harness!.db.select().from(inboxMessages);
    expect(inbox[0]!.status).toBe('processed');
    expect(inbox[0]!.ticketId).toBe(t.id);
  });

  it('IT-INTAKE-002: 20 concurrent intakes → contiguous codes, no gaps/dups', async () => {
    if (!ready) return;
    for (let i = 1; i <= 20; i++) {
      const mid = `<conc-${i}@x.com>`;
      await seedInbox(harness!.db, HRIS, BOX, makeRaw({ from: `u${i}@x.com`, to: BOX, messageId: mid }), mid);
    }
    // Two workers racing — atomic counter must still yield #00001..#00020.
    await Promise.all([intake.processReceived(), intake.processReceived()]);

    const codes = (await harness!.db.select({ code: tickets.ticketCode }).from(tickets)).map((r) => r.code).sort();
    expect(codes).toHaveLength(20);
    expect(new Set(codes).size).toBe(20); // no dup
    const expected = Array.from({ length: 20 }, (_, i) => `#${String(i + 1).padStart(5, '0')}`).sort();
    expect(codes).toEqual(expected); // contiguous, no gap
  });

  it('IT-INTAKE-003: replay (ticket already linked) does not create a second ticket', async () => {
    if (!ready) return;
    const mid = '<replay@x.com>';
    const inboxId = await seedInbox(harness!.db, HRIS, BOX, makeRaw({ from: 'a@x.com', to: BOX, messageId: mid }), mid);

    // First pass creates the ticket + links + flips to processed.
    await intake.processReceived();
    // Simulate "crashed before flip": rewind status to received but keep the ticket link.
    await harness!.db.update(inboxMessages).set({ status: 'received' }).where(eq(inboxMessages.id, inboxId));

    const n = await intake.processReceived();
    expect(n).toBe(1); // it claimed the row...
    const all = await harness!.db.select().from(tickets);
    expect(all).toHaveLength(1); // ...but did NOT create a second ticket
    const inbox = await harness!.db.select().from(inboxMessages);
    expect(inbox[0]!.status).toBe('processed');
  });

  it('IT-INTAKE-004: migration hook — explicit createdAt + external source', async () => {
    if (!ready) return;
    const mid = '<mig@x.com>';
    const inboxId = await seedInbox(harness!.db, HRIS, BOX, makeRaw({ from: 'a@x.com', to: BOX, messageId: mid }), mid);
    const explicit = new Date('2024-01-15T08:30:00.000Z');

    await withActor(systemActor, async (tx) => {
      const [row] = await tx.select().from(inboxMessages).where(eq(inboxMessages.id, inboxId));
      const parsed = await parseMail(row!.raw);
      await createTicketFromMail(tx, {
        projectId: HRIS,
        mailbox: BOX,
        inboxMessageId: inboxId,
        parsed,
        createdAt: explicit,
        externalSource: 'freshdesk',
        externalId: 'FD-42',
      });
    });

    const t = (await harness!.db.select().from(tickets))[0]!;
    expect(new Date(t.createdAt).toISOString()).toBe(explicit.toISOString());
    expect(t.externalSource).toBe('freshdesk');
    expect(t.externalId).toBe('FD-42');
  });

  it('IT-INTAKE-005: message stamps received_at (ingest) and clamps a future Date header', async () => {
    if (!ready) return;
    const mid = '<future@x.com>';
    const inboxId = await seedInbox(harness!.db, HRIS, BOX, makeRaw({ from: 'b@x.com', to: BOX, messageId: mid }), mid);
    const before = Date.now();
    await withActor(systemActor, async (tx) => {
      const [row] = await tx.select().from(inboxMessages).where(eq(inboxMessages.id, inboxId));
      const parsed = await parseMail(row!.raw);
      // Spoofed/skewed FUTURE Date header (3 days ahead) — must NOT drive display time.
      parsed.date = new Date(Date.now() + 3 * 86_400_000);
      await createTicketFromMail(tx, { projectId: HRIS, mailbox: BOX, inboxMessageId: inboxId, parsed });
    });
    const [msg] = await harness!.db.select().from(ticketMessages);
    // Write-path stamps received_at (12.1) — a regression that drops it would fail HERE,
    // unlike the read-only IT-THREAD tests that insert received_at by hand.
    expect(msg!.receivedAt).not.toBeNull();
    const rcv = new Date(msg!.receivedAt!).getTime();
    expect(rcv).toBeGreaterThanOrEqual(before - 5000);
    expect(rcv).toBeLessThanOrEqual(Date.now() + 5000);
    // created_at (display) is clamped to ingest, NOT the +3d header.
    expect(new Date(msg!.createdAt).getTime()).toBeLessThan(Date.now() + 86_400_000);
  });
});
