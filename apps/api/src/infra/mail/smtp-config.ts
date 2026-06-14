import type { ProjectKey } from '../db/schema';

export interface SmtpSettings {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  secure: boolean;
  /** Envelope/From address — the project mailbox the requester replies back to. */
  from: string;
}

/**
 * Per-project SMTP settings from env (bootstrap source; Story 11.1 moves this to
 * DB email_connections with DB-over-env precedence). The outbox sender uses this
 * to send business mail FROM the right project mailbox so reply threading stays
 * inside one Gmail conversation. Distinct from the transactional Mailer (OTP) — but
 * both read the same SMTP_<P>_* env.
 */
export function smtpConfigFor(projectKey: ProjectKey): SmtpSettings {
  const p = projectKey.toUpperCase();
  const user = process.env[`SMTP_${p}_USER`];
  const mailbox = process.env[`IMAP_${p}_USER`]; // the address we also poll
  return {
    host: process.env[`SMTP_${p}_HOST`] ?? 'localhost',
    port: Number(process.env[`SMTP_${p}_PORT`] ?? 1025),
    user,
    pass: process.env[`SMTP_${p}_PASSWORD`],
    secure: process.env[`SMTP_${p}_SECURE`] === 'true',
    from: process.env[`SMTP_${p}_FROM`] ?? user ?? mailbox ?? 'noreply@pmh.com.vn',
  };
}
