import { loggerParams } from './logger';

describe('logger redaction (IT-OPS-003 — config)', () => {
  it('redacts secrets so they never reach logs', () => {
    const redact = loggerParams.pinoHttp && (loggerParams.pinoHttp as { redact?: { paths: string[] } }).redact;
    const paths = redact?.paths ?? [];
    for (const p of ['*.password', '*.otp', '*.token', '*.passwordHash', 'req.headers.authorization']) {
      expect(paths).toContain(p);
    }
  });
});
