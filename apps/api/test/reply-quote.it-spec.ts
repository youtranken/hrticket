import { and, eq } from 'drizzle-orm';
import type { ItHarness } from './setup.it';
import { startHarness } from './setup.it';
import { makeUser } from './factories/user.factory';
import { tickets, ticketMessages, categories } from '../src/infra/db/schema';
import { ReplyService } from '../src/modules/tickets/reply.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const DAY = 86_400_000;
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
 * IT-QUOTE-001/002 — Story 12.10. A per-message Reply quotes AND threads onto the message
 * the user clicked (ticketMessageId), not always the latest — so the quoted context matches
 * the recipients (which 12.4 already took from that message). No ticketMessageId → latest.
 * Needs Docker.
 */
describe('IT-QUOTE: per-message reply quotes the clicked message', () => {
  let harness: ItHarness | undefined;
  let ready = false;
  const svc = new ReplyService();
  let ADMIN: SessionUser;
  let ticketId = '';
  let m1 = ''; // older message
  let m2 = ''; // latest message

  const sentBody = async (id: string) => {
    const [msg] = await harness!.db
      .select({ bodyText: ticketMessages.bodyText, inReplyTo: ticketMessages.inReplyTo })
      .from(ticketMessages)
      .where(eq(ticketMessages.id, id));
    return msg!;
  };

  beforeAll(async () => {
    try {
      harness = await startHarness({ seed: true });
      const [payroll] = await harness.db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.projectId, 1), eq(categories.nameEn, 'Payroll')));
      const a = (await makeUser(harness.db, { projectId: 1, email: 'adm-quote@x.com', role: 'admin' }))!;
      ADMIN = session(a.id, a.email, 'admin', 1);
      const [tk] = await harness.db
        .insert(tickets)
        .values({
          projectId: 1,
          ticketCode: '#QUO01',
          subject: 'quote',
          requesterEmail: 'req@ext.com',
          mailbox: 'hris@test.local',
          status: 'in_progress',
          categoryId: payroll!.id,
          assigneeId: a.id,
        })
        .returning({ id: tickets.id });
      ticketId = tk!.id;
      const [im1] = await harness.db
        .insert(ticketMessages)
        .values({
          ticketId,
          direction: 'inbound',
          fromAddr: 'req@ext.com',
          toAddrs: ['hris@test.local'],
          bodyText: 'OLD_MESSAGE_XYZ',
          messageId: '<m1@ext.com>',
          createdAt: new Date(Date.now() - 2 * DAY),
          receivedAt: new Date(Date.now() - 2 * DAY),
        })
        .returning({ id: ticketMessages.id });
      m1 = im1!.id;
      const [im2] = await harness.db
        .insert(ticketMessages)
        .values({
          ticketId,
          direction: 'inbound',
          fromAddr: 'req@ext.com',
          toAddrs: ['hris@test.local'],
          bodyText: 'NEW_MESSAGE_XYZ',
          messageId: '<m2@ext.com>',
          createdAt: new Date(Date.now() - 1 * DAY),
          receivedAt: new Date(Date.now() - 1 * DAY),
        })
        .returning({ id: ticketMessages.id });
      m2 = im2!.id;
      ready = true;
    } catch (e) {
      console.warn('[IT-QUOTE] Docker unavailable, skipping:', (e as Error)?.message);
    }
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  it('IT-QUOTE-001: reply on the OLDER message quotes + threads onto THAT message', async () => {
    if (!ready) return;
    const res = (await svc.reply(ADMIN, ticketId, {
      to: ['req@ext.com'],
      body: 'my reply to the old one',
      confirmNewRecipients: true,
      ticketMessageId: m1,
    })) as { ticketMessageId: string };
    const msg = await sentBody(res.ticketMessageId);
    expect(msg.bodyText).toContain('OLD_MESSAGE_XYZ'); // quoted the clicked (older) message
    expect(msg.bodyText).not.toContain('NEW_MESSAGE_XYZ'); // not the latest
    expect(msg.inReplyTo).toBe('<m1@ext.com>'); // threads onto the clicked message
  });

  it('IT-QUOTE-002: reply with NO ticketMessageId quotes the latest (regression)', async () => {
    if (!ready) return;
    // Fresh ticket so the "latest" is deterministic (IT-QUOTE-001 above added an outbound).
    const [payroll] = await harness!.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.projectId, 1), eq(categories.nameEn, 'Payroll')));
    const [tk] = await harness!.db
      .insert(tickets)
      .values({
        projectId: 1,
        ticketCode: '#QUO02',
        subject: 'quote2',
        requesterEmail: 'req2@ext.com',
        mailbox: 'hris@test.local',
        status: 'in_progress',
        categoryId: payroll!.id,
        assigneeId: ADMIN.id,
      })
      .returning({ id: tickets.id });
    const tid = tk!.id;
    await harness!.db.insert(ticketMessages).values({
      ticketId: tid,
      direction: 'inbound',
      fromAddr: 'req2@ext.com',
      toAddrs: ['hris@test.local'],
      bodyText: 'OLD2_XYZ',
      messageId: '<q2m1@ext.com>',
      createdAt: new Date(Date.now() - 2 * DAY),
      receivedAt: new Date(Date.now() - 2 * DAY),
    });
    await harness!.db.insert(ticketMessages).values({
      ticketId: tid,
      direction: 'inbound',
      fromAddr: 'req2@ext.com',
      toAddrs: ['hris@test.local'],
      bodyText: 'LATEST2_XYZ',
      messageId: '<q2m2@ext.com>',
      createdAt: new Date(Date.now() - 1 * DAY),
      receivedAt: new Date(Date.now() - 1 * DAY),
    });
    const res = (await svc.reply(ADMIN, tid, {
      to: ['req2@ext.com'],
      body: 'my reply to the latest',
      confirmNewRecipients: true,
    })) as { ticketMessageId: string };
    const msg = await sentBody(res.ticketMessageId);
    expect(msg.bodyText).toContain('LATEST2_XYZ'); // latest human message
    expect(msg.bodyText).not.toContain('OLD2_XYZ');
    expect(msg.inReplyTo).toBe('<q2m2@ext.com>'); // threads onto the latest inbound
  });
});
