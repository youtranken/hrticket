import type { ProjectKey } from '../db/schema';

export interface ImapSettings {
  host: string;
  port: number;
  user: string;
  pass?: string;
  secure: boolean;
}

export interface ProjectMailConfig {
  projectKey: ProjectKey;
  /** The address we poll — also the `mailbox` identity stored on inbox_messages/tickets. */
  mailbox: string;
  imap: ImapSettings;
}

/**
 * Per-project IMAP settings from env (bootstrap source; Story 11.1 moves this to
 * the DB email_connections with DB-over-env precedence). One connection per
 * project (NFR6). The mailbox identity is the IMAP user address.
 */
export function imapConfigFor(projectKey: ProjectKey): ProjectMailConfig {
  const p = projectKey.toUpperCase();
  const user = process.env[`IMAP_${p}_USER`] ?? '';
  return {
    projectKey,
    mailbox: user,
    imap: {
      host: process.env[`IMAP_${p}_HOST`] ?? 'localhost',
      port: Number(process.env[`IMAP_${p}_PORT`] ?? 143),
      user,
      pass: process.env[`IMAP_${p}_PASSWORD`],
      secure: process.env[`IMAP_${p}_SECURE`] === 'true',
    },
  };
}
