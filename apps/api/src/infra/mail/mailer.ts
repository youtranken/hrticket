import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Transactional mailer — sends DIRECTLY via SMTP (not via the outbox): OTP,
 * password reset, test-send, worker alerts (CLAUDE.md invariant #4). Connection
 * config comes from env now; Story 11.1 moves it to DB (email_connections) with
 * DB-over-env precedence.
 */
@Injectable()
export class Mailer {
  private readonly logger = new Logger(Mailer.name);
  private transporter: Transporter | null = null;

  private getTransport(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HRIS_HOST ?? 'localhost',
        port: Number(process.env.SMTP_HRIS_PORT ?? 1025),
        secure: false,
        auth: process.env.SMTP_HRIS_USER
          ? { user: process.env.SMTP_HRIS_USER, pass: process.env.SMTP_HRIS_PASSWORD }
          : undefined,
        connectionTimeout: 10000,
      });
    }
    return this.transporter;
  }

  async send(msg: MailMessage): Promise<void> {
    const from = process.env.SMTP_HRIS_USER ?? 'noreply@pmh.com.vn';
    await this.getTransport().sendMail({ from, ...msg });
    this.logger.log(`mail sent to ${msg.to}`);
  }
}
