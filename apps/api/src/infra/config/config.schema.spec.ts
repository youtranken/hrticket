import { loadConfig } from './config.schema';

const validEnv = {
  DATABASE_URL: 'postgres://hris:hris@localhost:5432/hris',
  SESSION_SECRET: 'a-very-long-session-secret',
  HMAC_SIGNING_KEY: 'a-very-long-hmac-key-value',
  ATTACHMENT_ENCRYPTION_KEY: 'a-very-long-aes-key-value-x',
};

describe('config fail-fast (IT-OPS-002 equivalent, no Docker)', () => {
  it('parses a valid env', () => {
    const cfg = loadConfig({ ...validEnv } as NodeJS.ProcessEnv);
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.DATABASE_URL).toContain('postgres://');
  });

  it('throws naming the missing DATABASE_URL', () => {
    const env = { ...validEnv } as Record<string, string>;
    delete env.DATABASE_URL;
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('throws on too-short secret', () => {
    expect(() =>
      loadConfig({ ...validEnv, SESSION_SECRET: 'short' } as NodeJS.ProcessEnv),
    ).toThrow(/SESSION_SECRET/);
  });
});
