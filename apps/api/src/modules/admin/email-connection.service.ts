import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { emailConnections } from '../../infra/db/schema';
import type { ProjectKey } from '../../infra/db/schema';
import type { SessionUser } from '../auth/session.service';
import { writeAudit } from '../../infra/audit/audit';
import { encryptSecret, decryptSecret, maskSecret } from '../../infra/crypto/secret';
import { isSecurePort } from '../../infra/mail/connection-resolver';
import { imapConfigFor } from '../../infra/mail/mail-config';
import { smtpConfigFor } from '../../infra/mail/smtp-config';

const TEST_TIMEOUT_MS = 10_000;

export interface ConnectionView {
  source: 'db' | 'env';
  imapHost: string | null;
  imapPort: number | null;
  imapUser: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  passwordMask: string | null;
  status: string;
  lastCheckedAt: Date | null;
}

export interface ConnectionInput {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  /** Optional — omit to keep the stored App Password unchanged. */
  password?: string;
}

export interface TestLeg {
  ok: boolean;
  /** IMAP only — number of messages in INBOX on a successful login. */
  messages?: number;
  error?: string;
}

export interface TestResult {
  imap: TestLeg;
  smtp: TestLeg;
}

/**
 * Story 11.1 — per-project email connection config. The App Password is stored
 * AES-encrypted and NEVER returned (GET masks to `****<last4>`); test-connection
 * makes a REAL login both ways (IMAP open INBOX + SMTP verify/NOOP, no mail sent).
 * Admin → own project; SSA → any project (X-Project) — the controller gates that.
 */
@Injectable()
export class EmailConnectionService {
  private readonly logger = new Logger(EmailConnectionService.name);

  private async row(projectId: number) {
    const [r] = await withActor(systemActor, (tx) =>
      tx.select().from(emailConnections).where(eq(emailConnections.projectId, projectId)),
    );
    return r ?? null;
  }

  /** Effective config for the UI (DB row if present, else env bootstrap). Masked. */
  async get(projectId: number, projectKey: ProjectKey): Promise<ConnectionView> {
    const r = await this.row(projectId);
    if (r && r.imapHost) {
      const pass = r.passwordEncrypted ? this.safeDecrypt(r.passwordEncrypted) : null;
      return {
        source: 'db',
        imapHost: r.imapHost,
        imapPort: r.imapPort,
        imapUser: r.imapUser,
        smtpHost: r.smtpHost,
        smtpPort: r.smtpPort,
        smtpUser: r.smtpUser,
        passwordMask: maskSecret(pass),
        status: r.status,
        lastCheckedAt: r.lastCheckedAt,
      };
    }
    const imap = imapConfigFor(projectKey);
    const smtp = smtpConfigFor(projectKey);
    return {
      source: 'env',
      imapHost: imap.imap.host,
      imapPort: imap.imap.port,
      imapUser: imap.imap.user || null,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      smtpUser: smtp.user ?? null,
      passwordMask: maskSecret(imap.imap.pass ?? smtp.pass),
      status: r?.status ?? 'unknown',
      lastCheckedAt: r?.lastCheckedAt ?? null,
    };
  }

  async update(
    user: SessionUser,
    projectId: number,
    projectKey: ProjectKey,
    input: ConnectionInput,
  ): Promise<ConnectionView> {
    const existing = await this.row(projectId);
    const passwordEncrypted = input.password
      ? encryptSecret(input.password)
      : (existing?.passwordEncrypted ?? null);

    await withActor(systemActor, async (tx) => {
      await tx
        .insert(emailConnections)
        .values({
          projectId,
          imapHost: input.imapHost,
          imapPort: input.imapPort,
          imapUser: input.imapUser,
          smtpHost: input.smtpHost,
          smtpPort: input.smtpPort,
          smtpUser: input.smtpUser,
          passwordEncrypted,
          // Settings changed → status is stale until the next Test/poll.
          status: 'unknown',
        })
        .onConflictDoUpdate({
          target: emailConnections.projectId,
          set: {
            imapHost: input.imapHost,
            imapPort: input.imapPort,
            imapUser: input.imapUser,
            smtpHost: input.smtpHost,
            smtpPort: input.smtpPort,
            smtpUser: input.smtpUser,
            passwordEncrypted,
            status: 'unknown',
          },
        });
      // Audit the change WITHOUT the password — only that it changed (AC3).
      await writeAudit(tx, {
        projectId,
        actorId: user.id,
        actorLabel: user.email,
        action: 'email_connection.changed',
        objectType: 'email_connection',
        objectId: String(projectId),
        oldValue: existing
          ? {
              imapHost: existing.imapHost,
              imapPort: existing.imapPort,
              imapUser: existing.imapUser,
              smtpHost: existing.smtpHost,
              smtpPort: existing.smtpPort,
              smtpUser: existing.smtpUser,
            }
          : null,
        newValue: {
          imapHost: input.imapHost,
          imapPort: input.imapPort,
          imapUser: input.imapUser,
          smtpHost: input.smtpHost,
          smtpPort: input.smtpPort,
          smtpUser: input.smtpUser,
          passwordChanged: !!input.password,
        },
      });
    });

    return this.get(projectId, projectKey);
  }

  /**
   * Real two-way connectivity check (AC1). Uses the SUBMITTED form values so an
   * SSA can test before saving; the password falls back to the stored one when
   * the form leaves it blank. Each leg is independent — one can be ✅ while the
   * other is ❌. Persists status/last_checked on the row when it exists (AC4).
   */
  async testConnection(
    projectId: number,
    input: ConnectionInput,
  ): Promise<TestResult> {
    const existing = await this.row(projectId);
    const password =
      input.password ??
      (existing?.passwordEncrypted ? this.safeDecrypt(existing.passwordEncrypted) ?? undefined : undefined);

    const [imap, smtp] = await Promise.all([
      this.testImap(input.imapHost, input.imapPort, input.imapUser, password),
      this.testSmtp(input.smtpHost, input.smtpPort, input.smtpUser, password),
    ]);

    const ok = imap.ok && smtp.ok;
    if (existing) {
      await withActor(systemActor, (tx) =>
        tx
          .update(emailConnections)
          .set({ status: ok ? 'ok' : 'error', lastCheckedAt: new Date() })
          .where(eq(emailConnections.projectId, projectId)),
      );
    }
    return { imap, smtp };
  }

  private async testImap(
    host: string,
    port: number,
    user: string,
    pass?: string,
  ): Promise<TestLeg> {
    const client = new ImapFlow({
      host,
      port,
      secure: isSecurePort(port),
      auth: { user, pass: pass ?? '' },
      logger: false,
      connectionTimeout: TEST_TIMEOUT_MS,
      greetingTimeout: TEST_TIMEOUT_MS,
      socketTimeout: TEST_TIMEOUT_MS,
    });
    try {
      await this.withTimeout(client.connect());
      const lock = await client.getMailboxLock('INBOX');
      let messages = 0;
      try {
        const st = await client.status('INBOX', { messages: true });
        messages = st.messages ?? 0;
      } finally {
        lock.release();
      }
      await client.logout().catch(() => client.close());
      return { ok: true, messages };
    } catch (e) {
      try {
        client.close();
      } catch {
        /* already closed */
      }
      return { ok: false, error: this.friendly(e) };
    }
  }

  private async testSmtp(
    host: string,
    port: number,
    user: string,
    pass?: string,
  ): Promise<TestLeg> {
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: isSecurePort(port),
      auth: user ? { user, pass } : undefined,
      connectionTimeout: TEST_TIMEOUT_MS,
      greetingTimeout: TEST_TIMEOUT_MS,
      socketTimeout: TEST_TIMEOUT_MS,
    });
    try {
      // verify() = connect + (auth) + NOOP. Never sends a real message.
      await this.withTimeout(transport.verify());
      transport.close();
      return { ok: true };
    } catch (e) {
      try {
        transport.close();
      } catch {
        /* already closed */
      }
      return { ok: false, error: this.friendly(e) };
    }
  }

  /** Hard ceiling so a black-hole host can't hang the request past the SLA. */
  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), TEST_TIMEOUT_MS).unref(),
      ),
    ]);
  }

  /** Short, password-free reason for the UI. Never echoes credentials. Folds in
   *  the error `.code` since some socket rejections carry an empty `.message`. */
  private friendly(e: unknown): string {
    const err = e as { message?: string; code?: string } | undefined;
    const msg = [err?.code, err?.message].filter(Boolean).join(' ') || String(e);
    if (/auth|login|credential|invalid|535|534/i.test(msg)) return 'auth failed';
    if (/ECONNREFUSED|refused/i.test(msg)) return 'connection refused';
    if (/timeout|ETIMEDOUT|timed out/i.test(msg)) return 'timeout';
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'host not found';
    return msg.slice(0, 120) || 'connection error';
  }

  private safeDecrypt(blob: string): string | null {
    try {
      return decryptSecret(blob);
    } catch (e) {
      this.logger.warn(`could not decrypt stored App Password: ${(e as Error)?.message}`);
      return null;
    }
  }
}
