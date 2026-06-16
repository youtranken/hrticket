import { eq } from 'drizzle-orm';
import { withActor, systemActor } from '../db/with-actor';
import { projects, emailConnections } from '../db/schema';
import type { ProjectKey } from '../db/schema';
import { decryptSecret } from '../crypto/secret';
import { imapConfigFor, type ProjectMailConfig } from './mail-config';
import { smtpConfigFor, type SmtpSettings } from './smtp-config';

/**
 * Story 11.1 — single source of truth for a project's live IMAP/SMTP settings,
 * with DB-over-env precedence (party-mode A9):
 *   - an `email_connections` row exists (UI-managed) → it WINS, App Password
 *     decrypted from `password_encrypted`;
 *   - no row → fall back to the bootstrap `*_<P>_*` env (Epic 1).
 * Read fresh on every poll/send so an SSA edit takes effect next cycle without a
 * container restart (AC2). One shared App Password serves both IMAP and SMTP.
 */
interface EcRow {
  imapHost: string | null;
  imapPort: number | null;
  imapUser: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  passwordEncrypted: string | null;
}

/** TLS is implied by the canonical secure ports (Gmail 993/465); GreenMail's
 *  random mapped ports resolve to plaintext, which is what the tests want. */
export function isSecurePort(port: number): boolean {
  return port === 993 || port === 465;
}

/** Submission port 587 speaks plaintext then upgrades via STARTTLS. Force the
 *  upgrade (`requireTLS`) so an App Password can never transit in cleartext if a
 *  provider omits STARTTLS — without this, `secure:false` on 587 would auth in the
 *  clear. GreenMail/dev (port 1025/3025/random) is NOT 587, so it stays plaintext,
 *  which the integration tests rely on. */
export function requiresStartTls(port: number): boolean {
  return port === 587;
}

export async function loadConnectionRow(projectId: number): Promise<EcRow | null> {
  return withActor(systemActor, async (tx) => {
    const [row] = await tx
      .select({
        imapHost: emailConnections.imapHost,
        imapPort: emailConnections.imapPort,
        imapUser: emailConnections.imapUser,
        smtpHost: emailConnections.smtpHost,
        smtpPort: emailConnections.smtpPort,
        smtpUser: emailConnections.smtpUser,
        passwordEncrypted: emailConnections.passwordEncrypted,
      })
      .from(emailConnections)
      .where(eq(emailConnections.projectId, projectId));
    return row ?? null;
  });
}

async function projectIdFor(projectKey: ProjectKey): Promise<number | null> {
  const [p] = await withActor(systemActor, (tx) =>
    tx.select({ id: projects.id }).from(projects).where(eq(projects.key, projectKey)),
  );
  return p?.id ?? null;
}

export async function resolveImapConfig(projectKey: ProjectKey): Promise<ProjectMailConfig> {
  const id = await projectIdFor(projectKey);
  const row = id ? await loadConnectionRow(id) : null;
  if (row && row.imapHost && row.imapUser) {
    const port = row.imapPort ?? 993;
    let pass: string | undefined;
    try {
      pass = row.passwordEncrypted ? decryptSecret(row.passwordEncrypted) : undefined;
    } catch {
      // A corrupt blob or a rotated EMAIL_SECRET_KEY would otherwise throw on EVERY
      // poll cycle and wedge the whole mail subsystem with no self-heal. Fall back to
      // the bootstrap env config instead (same as "no row").
      return imapConfigFor(projectKey);
    }
    return {
      projectKey,
      mailbox: row.imapUser,
      imap: { host: row.imapHost, port, user: row.imapUser, pass, secure: isSecurePort(port) },
    };
  }
  return imapConfigFor(projectKey);
}

export async function resolveSmtpConfig(projectKey: ProjectKey): Promise<SmtpSettings> {
  const id = await projectIdFor(projectKey);
  const row = id ? await loadConnectionRow(id) : null;
  if (row && row.smtpHost && row.smtpUser) {
    const port = row.smtpPort ?? 465;
    let pass: string | undefined;
    try {
      pass = row.passwordEncrypted ? decryptSecret(row.passwordEncrypted) : undefined;
    } catch {
      // Corrupt blob / rotated key → fall back to env rather than crash every send.
      return smtpConfigFor(projectKey);
    }
    return { host: row.smtpHost, port, user: row.smtpUser, pass, secure: isSecurePort(port), from: row.smtpUser };
  }
  return smtpConfigFor(projectKey);
}
