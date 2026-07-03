import type { DbTx } from '../../infra/db/with-actor';
import { emailConnections } from '../../infra/db/schema';

/**
 * Every address that IS one of our project mailboxes: the receiving mailbox itself,
 * the configured IMAP/SMTP users (DB `email_connections` wins over env, 11.1), and
 * the env fallbacks. Participant admission must exclude these — a cross-posted mail
 * lists BOTH project mailboxes in To, and admitting the sibling as a participant
 * would put it on every reply-all, looping our own replies back into ingest.
 */
export async function systemMailboxAddresses(
  tx: DbTx,
  receivingMailbox: string,
): Promise<Set<string>> {
  const rows = await tx
    .select({ imapUser: emailConnections.imapUser, smtpUser: emailConnections.smtpUser })
    .from(emailConnections);
  const envAddrs = [
    process.env.IMAP_HRIS_USER,
    process.env.IMAP_CNB_USER,
    process.env.SMTP_HRIS_FROM,
    process.env.SMTP_CNB_FROM,
    process.env.SMTP_HRIS_USER,
    process.env.SMTP_CNB_USER,
  ];
  return new Set(
    [receivingMailbox, ...rows.flatMap((r) => [r.imapUser, r.smtpUser]), ...envAddrs]
      .filter((a): a is string => !!a && a.includes('@'))
      .map((a) => a.toLowerCase()),
  );
}
