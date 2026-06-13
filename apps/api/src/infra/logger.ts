import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';

/**
 * pino structured logging config. Every HTTP request gets a stable `requestId`,
 * and sensitive fields are redacted so passwords/OTPs/tokens/sensitive payloads
 * never reach the logs (CLAUDE.md invariant #13).
 */
export const loggerParams: Params = {
  pinoHttp: {
    genReqId: (req, res) => {
      const existing = (req.headers['x-request-id'] as string) || randomUUID();
      res.setHeader('x-request-id', existing);
      return existing;
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.passwordHash',
        '*.otp',
        '*.code',
        '*.codeHash',
        '*.token',
        '*.tokenHash',
        '*.passwordEncrypted',
        'password',
        'otp',
        'token',
      ],
      censor: '[Redacted]',
    },
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
  },
};
