import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { TicketStatus } from '@hris/shared';
import { withActor } from '../../infra/db/with-actor';
import { tickets, ticketMessages, participants, categories, drafts } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import { actorForUser } from './actor';
import { sendOutboundMail } from './send-mail.usecase';
import { canTransition, assertCanReplyTicket } from './ticket.state-machine';
import { systemMailboxAddresses } from '../email-engine/mailbox-addresses';
import { autoCloseLockedSiblings } from './cross-post-lock';

export interface ReplyInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  body: string;
  bodyHtml?: string;
  attachmentIds?: string[];
  /** Client acknowledges the new-recipient warning (AC3). */
  confirmNewRecipients?: boolean;
  /** Reply & Close (FR39): send the reply AND close the ticket in one tx (5.2). */
  closeAfter?: boolean;
  /** Send-with-status (đơn 6): move to Pending (needs snoozeUntil) or Resolved in
   *  the same tx as the send. The close tickbox (closeAfter) wins when both are set. */
  statusAfter?: 'pending' | 'resolved';
  /** Future VN day 'YYYY-MM-DD' — required when statusAfter='pending'. */
  snoozeUntil?: string;
}

export interface ReplyDefaults {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  isSensitive: boolean;
}

export interface ForwardInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  /** Optional intro typed above the forwarded block (Gmail lets it be empty). */
  body?: string;
  /** ticket_messages.id of the message being forwarded — must belong to this ticket. */
  ticketMessageId: string;
  /** Client acknowledges the new-recipient warning (same gate as reply). */
  confirmNewRecipients?: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function htmlFromText(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
}

/**
 * Reply subject = `Re: <original>` with NO `[#code]` marker. Gmail groups a
 * conversation only when the subject matches modulo Re:/Fwd: — the old
 * `[#00012] <subject>` prefix split every ticket into a second conversation on the
 * requester's side. Inbound→ticket matching runs on In-Reply-To/References (the
 * primary mechanism in threading.ts); the code moves to a small body footer.
 */
function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Forward subject = `Fwd: <original>` — same no-`[#code]` rule as replySubject. */
function fwdSubject(subject: string): string {
  return /^\s*fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

/** Small grey footer carrying the ticket code (the subject no longer does). */
function codeFooterText(ticketCode: string): string {
  return `\n\n-- \nMã yêu cầu / Ticket: ${ticketCode}`;
}
function codeFooterHtml(ticketCode: string): string {
  return `<div style="color:#8b93a3;font-size:12px;margin-top:16px">Mã yêu cầu / Ticket: ${escapeHtml(ticketCode)}</div>`;
}

/**
 * Gmail-style quote of the message being replied to: an attribution line + the
 * previous body inside a left-bordered blockquote. Because each outbound already
 * carries ITS quote, the borders nest naturally (│ │ │) down the thread, exactly
 * like Gmail. Inline <img> are stripped from the quoted copy — their src are
 * app-internal signed placeholders that a mail client can't resolve.
 */
function gmailQuote(prev: { createdAt: Date; fromAddr: string; bodyHtmlSafe: string | null; bodyText: string | null }): {
  html: string;
  text: string;
} {
  const when = prev.createdAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const attr = `Vào ${when}, <${prev.fromAddr}> đã viết:`;
  // `||` not `??`: a text-only inbound stores bodyHtmlSafe as '' (sanitize of a null
  // html part), which must still fall back to the text body — `??` quoted it as EMPTY.
  const innerHtml = (prev.bodyHtmlSafe?.trim() || htmlFromText(prev.bodyText ?? '')).replace(/<img\b[^>]*>/gi, '');
  const html =
    `<br><div class="gmail_quote"><div class="gmail_attr" style="color:#5f6368">${escapeHtml(attr)}</div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${innerHtml}</blockquote></div>`;
  const text = `\n\n${attr}\n${(prev.bodyText ?? '').split('\n').map((l) => `> ${l}`).join('\n')}`;
  return { html, text };
}

/**
 * Gmail-style forwarded block: the "---------- Forwarded message ----------" header
 * (From/Date/Subject/To/Cc) followed by the original body inline — NOT a blockquote;
 * quotes already nested inside the forwarded body keep their │ borders. BCC of an
 * outbound original is deliberately absent from the header (never leak bcc onward).
 */
function forwardedBlock(msg: {
  createdAt: Date;
  fromAddr: string;
  toAddrs: string[] | null;
  ccAddrs: string[] | null;
  bodyHtmlSafe: string | null;
  bodyText: string | null;
  subject: string;
}): { html: string; text: string } {
  const when = msg.createdAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const lines = [
    '---------- Forwarded message / Thư chuyển tiếp ----------',
    `Từ / From: <${msg.fromAddr}>`,
    `Ngày / Date: ${when}`,
    `Tiêu đề / Subject: ${msg.subject}`,
    ...(msg.toAddrs?.length ? [`Đến / To: ${msg.toAddrs.join(', ')}`] : []),
    ...(msg.ccAddrs?.length ? [`Cc: ${msg.ccAddrs.join(', ')}`] : []),
  ];
  const innerHtml = (msg.bodyHtmlSafe?.trim() || htmlFromText(msg.bodyText ?? '')).replace(/<img\b[^>]*>/gi, '');
  const html =
    `<br><div class="gmail_quote"><div class="gmail_attr" style="color:#5f6368">` +
    lines.map((l) => escapeHtml(l)).join('<br>') +
    `</div><br>${innerHtml}</div>`;
  const text = `\n\n${lines.join('\n')}\n\n${msg.bodyText ?? ''}`;
  return { html, text };
}

@Injectable()
export class ReplyService {
  /**
   * Reply-All suggestion (FR9, v2): the recipients MIRROR THE LATEST MAIL on the
   * thread — exactly like hitting Reply-All on the newest message in Gmail — instead
   * of accumulating every address ever seen. Latest inbound → To = its sender + its
   * To-recipients, CC = its CC; latest outbound (we spoke last) → the same audience
   * (To/CC/BCC) again. Our own project mailboxes are always dropped.
   */
  async getDefaults(user: SessionUser, ticketId: string): Promise<ReplyDefaults> {
    const actor = await actorForUser(user);
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          requester: tickets.requesterEmail,
          subject: tickets.subject,
          ticketCode: tickets.ticketCode,
          mailbox: tickets.mailbox,
          isSensitive: categories.isSensitive,
        })
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .where(eq(tickets.id, ticketId));
      if (!t) throw new NotFoundException('Ticket not found');

      // "Latest mail" = the newest REAL correspondence — internal notes and machine
      // mail (our auto-ack, their out-of-office) don't steer the audience: the ack
      // goes to the requester alone and would silently drop the CC'd colleagues.
      const [last] = await tx
        .select({
          direction: ticketMessages.direction,
          fromAddr: ticketMessages.fromAddr,
          toAddrs: ticketMessages.toAddrs,
          ccAddrs: ticketMessages.ccAddrs,
          bccAddrs: ticketMessages.bccAddrs,
        })
        .from(ticketMessages)
        .where(
          and(
            eq(ticketMessages.ticketId, ticketId),
            eq(ticketMessages.isInternal, false),
            eq(ticketMessages.isAutoReply, false),
          ),
        )
        .orderBy(desc(ticketMessages.createdAt))
        .limit(1);

      const own = await systemMailboxAddresses(tx, t.mailbox);
      // An address a human explicitly REJECTED never re-enters the suggestion, even
      // when the latest mail still carries it on To/CC (review #2 — migration 0012
      // kept rejected rows on purpose, honouring the old decision).
      const rejected = new Set(
        (
          await tx
            .select({ email: participants.email })
            .from(participants)
            .where(and(eq(participants.ticketId, ticketId), eq(participants.status, 'rejected')))
        ).map((p) => p.email.toLowerCase()),
      );
      const seen = new Set<string>();
      const keep = (e: string | null | undefined): e is string => {
        if (!e) return false;
        const k = e.toLowerCase();
        if (own.has(k) || rejected.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      };

      let to: string[] = [];
      let cc: string[] = [];
      let bcc: string[] = [];
      if (last?.direction === 'inbound') {
        to = [last.fromAddr, ...(last.toAddrs ?? [])].filter(keep);
        cc = (last.ccAddrs ?? []).filter(keep);
      } else if (last) {
        to = (last.toAddrs ?? []).filter(keep);
        cc = (last.ccAddrs ?? []).filter(keep);
        bcc = (last.bccAddrs ?? []).filter(keep);
      }
      if (to.length === 0) to = [t.requester];

      return { to, cc, bcc, subject: replySubject(t.subject), isSensitive: t.isSensitive ?? false };
    });
  }

  /**
   * Send an employee reply (FR6/7/8/9). One tx: optionally admit new recipients to
   * participants, write the outbound message with a fresh Message-ID, and enqueue
   * the outbox row with In-Reply-To/References threading + a Gmail-threadable
   * `Re:` subject (ticket code lives in the body footer, not the subject).
   * New (never-seen) addresses are allowed but require confirmNewRecipients — the
   * server is the gate, the modal is only UX (party-mode J2).
   */
  async reply(
    user: SessionUser,
    ticketId: string,
    input: ReplyInput,
  ): Promise<
    | { ticketMessageId: string; messageId: string; closed: boolean; status?: TicketStatus }
    | { needsConfirm: true; newRecipients: string[] }
  > {
    const actor = await actorForUser(user);
    const groups = actor.kind === 'user' ? actor.groups : [];
    const out = await withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          id: tickets.id,
          projectId: tickets.projectId,
          mailbox: tickets.mailbox,
          subject: tickets.subject,
          ticketCode: tickets.ticketCode,
          status: tickets.status,
          assigneeId: tickets.assigneeId,
          categoryId: tickets.categoryId,
        })
        .from(tickets)
        // Lock the ticket for the whole tx so Reply & Close is atomic: the status can't
        // move between the legality precheck and the close write — no half-done state (P6/AC1).
        .where(eq(tickets.id, ticketId))
        .for('update');
      if (!t) throw new NotFoundException('Ticket not found');

      // Sending company email on a ticket is a privileged act AND a processing action:
      // only the assignee or the TL-in-group may reply — NOT a non-assignee member (M1),
      // and NOT Admin/SSA (administrative: they assign + oversee, they don't process by
      // replying). Gates the plain reply too, not just Reply & Close.
      assertCanReplyTicket(user, groups, t);
      // Cross-post is OPEN-HANDED: both projects may reply to their side of a shared
      // request, each from its OWN mailbox; the detail view merges both conversations.

      // Reply & Close (AC1): the close must be legal BEFORE we send, so we never leave a
      // sent mail on a ticket we couldn't close. The ticket row is locked above, so the
      // status is stable for the rest of the tx. Pending is closable here because the
      // reply first wakes it to In Progress (see below), from which the close is legal.
      if (input.closeAfter) {
        const closable =
          canTransition(t.status as TicketStatus, 'closed').ok || t.status === 'pending';
        if (!closable) {
          throw new ConflictException('INVALID_TRANSITION');
        }
      }

      // Send-with-status (đơn 6): "Gửi & Chờ phản hồi" / "Gửi & Đã giải quyết". The
      // reply itself counts as actively working the ticket, so open/assigned/pending
      // pass through In Progress before the target edge is judged (each hop is legal
      // stepwise). Same precheck-before-send rule as Reply & Close; the date check
      // mirrors the lifecycle service (422 wins over 409). Close tickbox wins.
      const statusAfter = input.closeAfter ? undefined : input.statusAfter;
      if (statusAfter) {
        if (statusAfter === 'pending') {
          if (!input.snoozeUntil) throw new UnprocessableEntityException('PENDING_REQUIRES_SNOOZE');
          const rows = (await tx.execute(
            sql`SELECT (${input.snoozeUntil}::date < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS past`,
          )) as unknown as Array<{ past: boolean }>;
          if (rows[0]?.past) throw new UnprocessableEntityException('SNOOZE_DATE_IN_PAST');
        }
        const effFrom: TicketStatus = ['open', 'assigned', 'pending'].includes(t.status)
          ? 'in_progress'
          : (t.status as TicketStatus);
        const verdict = canTransition(effFrom, statusAfter, { hasSnoozeUntil: !!input.snoozeUntil });
        if (!verdict.ok) throw new ConflictException('INVALID_TRANSITION');
      }

      const allRecipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((e) =>
        e.toLowerCase(),
      );

      // Known = any participant we've seen (active OR pending) + the requester.
      const known = new Set(
        (
          await tx
            .select({ email: participants.email })
            .from(participants)
            // A REJECTED address is deliberately NOT "known": sending to it again must
            // re-trip the confirm modal (review #2) — confirming re-admits it as active.
            .where(
              and(eq(participants.ticketId, ticketId), sql`${participants.status} <> 'rejected'`),
            )
        ).map((p) => p.email.toLowerCase()),
      );
      const newRecipients = [...new Set(allRecipients)].filter((e) => !known.has(e));

      if (newRecipients.length > 0 && !input.confirmNewRecipients) {
        return { needsConfirm: true as const, newRecipients };
      }

      // Admit confirmed new addresses as active participants + audit (J2).
      for (const email of newRecipients) {
        await tx
          .insert(participants)
          .values({ ticketId, email, status: 'active' })
          .onConflictDoUpdate({
            target: [participants.ticketId, participants.email],
            set: { status: 'active' },
          });
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'participant.added_on_reply',
          objectType: 'ticket',
          objectId: ticketId,
          newValue: { email },
        });
      }

      // Threading: hook onto the latest inbound message (FR7).
      const [lastInbound] = await tx
        .select({ messageId: ticketMessages.messageId, references: ticketMessages.references })
        .from(ticketMessages)
        .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.direction, 'inbound')))
        .orderBy(desc(ticketMessages.createdAt))
        .limit(1);
      const inReplyTo = lastInbound?.messageId ?? null;
      const references = [lastInbound?.references, lastInbound?.messageId]
        .filter((x): x is string => !!x)
        .join(' ') || null;

      // Quote the message being replied to (Gmail-style, nests down the thread) so
      // every recipient sees the context inside the mail itself — internal notes and
      // machine mail (auto-ack / out-of-office) excluded: the agent replies to the
      // human conversation, not to the robot.
      const [prevMsg] = await tx
        .select({
          createdAt: ticketMessages.createdAt,
          fromAddr: ticketMessages.fromAddr,
          bodyHtmlSafe: ticketMessages.bodyHtmlSafe,
          bodyText: ticketMessages.bodyText,
        })
        .from(ticketMessages)
        .where(
          and(
            eq(ticketMessages.ticketId, ticketId),
            eq(ticketMessages.isInternal, false),
            eq(ticketMessages.isAutoReply, false),
          ),
        )
        .orderBy(desc(ticketMessages.createdAt))
        .limit(1);
      const quote = prevMsg ? gmailQuote(prevMsg) : { html: '', text: '' };

      const typedHtml = input.bodyHtml ?? htmlFromText(input.body);
      const bodyText = `${input.body}${codeFooterText(t.ticketCode)}${quote.text}`;
      const bodyHtml = `${typedHtml}${codeFooterHtml(t.ticketCode)}${quote.html}`;
      const res = await sendOutboundMail(tx, {
        projectId: t.projectId,
        ticketId,
        fromAddr: t.mailbox,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: replySubject(t.subject),
        bodyText,
        bodyHtml,
        inReplyTo,
        references,
        attachmentIds: input.attachmentIds,
      });

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.replied',
        objectType: 'ticket',
        objectId: ticketId,
        newValue: { messageId: res.messageId, to: input.to, cc: input.cc ?? [], bcc: input.bcc ?? [] },
      });

      // Auto-claim on reply (#6): replying to an UNASSIGNED ticket takes it over so it
      // leaves the group pool — a pool ticket with an outbound reply but no owner is the
      // illogical state we're closing. Same tx; an open pool ticket also moves to
      // 'assigned' (mirrors claim), unless we're about to close it below.
      if (!t.assigneeId) {
        await tx
          .update(tickets)
          .set({
            assigneeId: user.id,
            assignedAt: new Date(),
            ...(t.status === 'open' && !input.closeAfter ? { status: 'assigned' as const } : {}),
          })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.assigned',
          objectType: 'ticket',
          objectId: ticketId,
          oldValue: { assigneeId: null },
          newValue: { assigneeId: user.id, via: 'reply' },
        });
      }

      // Wake a snoozed (Pending) ticket on reply: the agent is actively working it
      // again, so clear the snooze and resume In Progress — mirrors the inbound-reply
      // wake (5.3). Skipped when we're closing it outright just below.
      if (t.status === 'pending' && !input.closeAfter && !statusAfter) {
        await tx
          .update(tickets)
          .set({ status: 'in_progress', snoozeUntil: null, lastOpenedAt: new Date() })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.status_changed',
          objectType: 'ticket',
          objectId: ticketId,
          oldValue: { status: t.status },
          newValue: { status: 'in_progress', via: 'reply_wake' },
        });
      }

      // Reply sent → drop this user's reply draft IN THE SAME TX, so a stale draft
      // can't reload after a successful send and tempt a duplicate reply (FR105).
      await tx
        .delete(drafts)
        .where(
          and(eq(drafts.ticketId, ticketId), eq(drafts.userId, user.id), eq(drafts.kind, 'reply')),
        );

      // Reply & Close (FR39/NFR10): flip to Closed in the SAME tx. The outbox row is
      // already enqueued, so the mail is guaranteed to go even though we're now closed
      // — a rollback (e.g. enqueue failure above) takes the close down with it.
      if (input.closeAfter) {
        await tx
          .update(tickets)
          .set({ status: 'closed', closedAt: new Date() })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.status_changed',
          objectType: 'ticket',
          objectId: ticketId,
          oldValue: { status: t.status },
          newValue: { status: 'closed', via: 'reply_and_close' },
        });
      }

      // Send-with-status (đơn 6): apply the pre-checked target in the SAME tx as the
      // send — the outbox row is already enqueued, a rollback takes both down together.
      if (statusAfter === 'resolved') {
        await tx
          .update(tickets)
          .set({ status: 'resolved', snoozeUntil: null })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.status_changed',
          objectType: 'ticket',
          objectId: ticketId,
          oldValue: { status: t.status },
          newValue: { status: 'resolved', via: 'reply_and_resolve' },
        });
      } else if (statusAfter === 'pending') {
        await tx
          .update(tickets)
          .set({ status: 'pending', snoozeUntil: input.snoozeUntil! })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.status_changed',
          objectType: 'ticket',
          objectId: ticketId,
          oldValue: { status: t.status },
          newValue: { status: 'pending', snoozeUntil: input.snoozeUntil, via: 'reply_and_snooze' },
        });
      }

      const finalStatus: TicketStatus | undefined = input.closeAfter ? 'closed' : statusAfter;
      return {
        ticketMessageId: res.ticketMessageId,
        messageId: res.messageId,
        closed: !!input.closeAfter,
        finalStatus,
        ticketCode: t.ticketCode,
      };
    });

    if ('needsConfirm' in out) return out;
    // Settling the request (resolved/closed) also settles a cross-post sibling that
    // nobody picked up — same post-commit system-actor cleanup as the lifecycle path.
    if (out.finalStatus === 'resolved' || out.finalStatus === 'closed') {
      await autoCloseLockedSiblings(ticketId, out.ticketCode, { id: user.id, email: user.email });
    }
    return {
      ticketMessageId: out.ticketMessageId,
      messageId: out.messageId,
      closed: out.closed,
      status: out.finalStatus,
    };
  }

  /**
   * Forward ONE message of the conversation to new recipients, Gmail-style: subject
   * `Fwd: <subject>`, typed intro + code footer + "Forwarded message" header block +
   * the original body. Same actor gate as reply (assignee / TL-in-group), same
   * new-recipient confirm; recipients join as ACTIVE participants. The outbound
   * carries In-Reply-To/References of the forwarded mail, so a recipient's reply
   * threads back into THIS ticket.
   */
  async forward(
    user: SessionUser,
    ticketId: string,
    input: ForwardInput,
  ): Promise<
    | { ticketMessageId: string; messageId: string }
    | { needsConfirm: true; newRecipients: string[] }
  > {
    const actor = await actorForUser(user);
    const groups = actor.kind === 'user' ? actor.groups : [];
    return withActor(actor, async (tx) => {
      const [t] = await tx
        .select({
          id: tickets.id,
          projectId: tickets.projectId,
          mailbox: tickets.mailbox,
          subject: tickets.subject,
          ticketCode: tickets.ticketCode,
          status: tickets.status,
          assigneeId: tickets.assigneeId,
          categoryId: tickets.categoryId,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .for('update');
      if (!t) throw new NotFoundException('Ticket not found');

      // Forwarding sends company email on the ticket → same gate as reply (assignee /
      // TL-in-group; Admin/SSA coordinate, they don't process).
      assertCanReplyTicket(user, groups, t);
      // Terminal tickets are settled — no more outbound, and especially no auto-claim
      // resurrecting a closed ticket past the state machine (review #5, mirrors claim()).
      if (t.status === 'closed' || t.status === 'resolved') {
        throw new ConflictException('INVALID_TRANSITION');
      }

      // The forwarded message must be OUR ticket's (a cross-post sibling's message id
      // would not resolve here → 404) and never an internal note.
      const [msg] = await tx
        .select({
          id: ticketMessages.id,
          direction: ticketMessages.direction,
          createdAt: ticketMessages.createdAt,
          fromAddr: ticketMessages.fromAddr,
          toAddrs: ticketMessages.toAddrs,
          ccAddrs: ticketMessages.ccAddrs,
          bodyHtmlSafe: ticketMessages.bodyHtmlSafe,
          bodyText: ticketMessages.bodyText,
          messageId: ticketMessages.messageId,
          references: ticketMessages.references,
        })
        .from(ticketMessages)
        .where(
          and(
            eq(ticketMessages.id, input.ticketMessageId),
            eq(ticketMessages.ticketId, ticketId),
            eq(ticketMessages.isInternal, false),
          ),
        );
      if (!msg) throw new NotFoundException('Message not found on this ticket');

      const allRecipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((e) =>
        e.toLowerCase(),
      );
      const known = new Set(
        (
          await tx
            .select({ email: participants.email })
            .from(participants)
            // A REJECTED address is deliberately NOT "known": sending to it again must
            // re-trip the confirm modal (review #2) — confirming re-admits it as active.
            .where(
              and(eq(participants.ticketId, ticketId), sql`${participants.status} <> 'rejected'`),
            )
        ).map((p) => p.email.toLowerCase()),
      );
      const newRecipients = [...new Set(allRecipients)].filter((e) => !known.has(e));
      if (newRecipients.length > 0 && !input.confirmNewRecipients) {
        return { needsConfirm: true as const, newRecipients };
      }
      for (const email of newRecipients) {
        await tx
          .insert(participants)
          .values({ ticketId, email, status: 'active' })
          .onConflictDoUpdate({
            target: [participants.ticketId, participants.email],
            set: { status: 'active' },
          });
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'participant.added_on_forward',
          objectType: 'ticket',
          objectId: ticketId,
          newValue: { email },
        });
      }

      // ticket_messages stores no subject — reconstruct the forwarded mail's display
      // subject from the ticket's (outbound replies went out as `Re: <subject>`).
      const fwd = forwardedBlock({
        ...msg,
        subject: msg.direction === 'outbound' ? replySubject(t.subject) : t.subject,
      });
      const intro = input.body?.trim() ?? '';
      const introHtml = intro ? htmlFromText(intro) : '';
      const bodyText = `${intro}${codeFooterText(t.ticketCode)}${fwd.text}`;
      const bodyHtml = `${introHtml}${codeFooterHtml(t.ticketCode)}${fwd.html}`;

      const res = await sendOutboundMail(tx, {
        projectId: t.projectId,
        ticketId,
        fromAddr: t.mailbox,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: fwdSubject(t.subject),
        bodyText,
        bodyHtml,
        // Thread onto the forwarded mail: the recipient's reply References our
        // Message-ID chain and lands back on this very ticket.
        inReplyTo: msg.messageId,
        references: [msg.references, msg.messageId].filter((x): x is string => !!x).join(' ') || null,
      });

      await writeAudit(tx, {
        projectId: t.projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'ticket.forwarded',
        objectType: 'ticket',
        objectId: ticketId,
        newValue: {
          messageId: res.messageId,
          forwardedTicketMessageId: msg.id,
          to: input.to,
          cc: input.cc ?? [],
          bcc: input.bcc ?? [],
        },
      });

      // Mirror reply's auto-claim: forwarding an unassigned ticket takes it over —
      // an outbound mail on a pool ticket with no owner is the state we're avoiding.
      if (!t.assigneeId) {
        await tx
          .update(tickets)
          .set({
            assigneeId: user.id,
            assignedAt: new Date(),
            ...(t.status === 'open' ? { status: 'assigned' as const } : {}),
          })
          .where(eq(tickets.id, ticketId));
        await writeAudit(tx, {
          projectId: t.projectId,
          actorId: user.id,
          actorLabel: user.email,
          action: 'ticket.assigned',
          objectType: 'ticket',
          objectId: ticketId,
          oldValue: { assigneeId: null },
          newValue: { assigneeId: user.id, via: 'forward' },
        });
      }

      return { ticketMessageId: res.ticketMessageId, messageId: res.messageId };
    });
  }
}
