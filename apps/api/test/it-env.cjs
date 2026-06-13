// Safe default env for integration tests so config fail-fast passes during module
// construction. The Testcontainers harness overrides DATABASE_URL at runtime.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://hris:hris@localhost:5432/hris';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-value-xx';
process.env.HMAC_SIGNING_KEY = process.env.HMAC_SIGNING_KEY || 'test-hmac-signing-key-value';
process.env.ATTACHMENT_ENCRYPTION_KEY =
  process.env.ATTACHMENT_ENCRYPTION_KEY || 'test-attachment-aes-key-value';
