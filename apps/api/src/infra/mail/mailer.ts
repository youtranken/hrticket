import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { resolveSmtpConfig } from './connection-resolver';

export interface MailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Transactional mailer — sends DIRECTLY via SMTP (not via the outbox): OTP,
 * password reset, test-send, worker alerts (CLAUDE.md invariant #4). Reads the
 * live SMTP connection from DB (email_connections) with DB-over-env precedence
 * (Story 11.1, party-mode J5) so it never stays pinned to a stale env after
 * go-live. Uses the `hris` system mailbox as the transactional sender.
 */
@Injectable()
export class Mailer {
  private readonly logger = new Logger(Mailer.name);
  private cached: { fp: string; t: Transporter } | null = null;

  private async getTransport(): Promise<{ transporter: Transporter; from: string }> {
    const cfg = await resolveSmtpConfig('hris');
    const fp = `${cfg.host}:${cfg.port}:${cfg.user ?? ''}:${cfg.secure}`;
    if (!this.cached || this.cached.fp !== fp) {
      if (this.cached) this.cached.t.close();
      this.cached = {
        fp,
        t: nodemailer.createTransport({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
          connectionTimeout: 10000,
        }),
      };
    }
    return { transporter: this.cached.t, from: cfg.from };
  }

  async send(msg: MailMessage): Promise<void> {
    const { transporter, from } = await this.getTransport();
    await transporter.sendMail({ from, ...msg });
    this.logger.log(`mail sent to ${msg.to}`);
  }
}
