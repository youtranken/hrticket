import { z } from 'zod';
import { loadSecretsFromFiles } from './load-secrets';

/** Environment contract. Parsed once at boot; missing/invalid → process exits (fail-fast). */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),

  SESSION_SECRET: z.string().min(16),
  HMAC_SIGNING_KEY: z.string().min(16),
  ATTACHMENT_ENCRYPTION_KEY: z.string().min(16),
  ATTACHMENT_STORAGE_ROOT: z.string().default('./attachments'),
  // Story 11.1 — AES key for the at-rest email App Password. Optional: when unset,
  // the secret module falls back to ATTACHMENT_ENCRYPTION_KEY (always present).
  EMAIL_SECRET_KEY: z.string().min(16).optional(),
  // Public base URL used to build links in transactional/digest email (reset, ticket
  // links). Defaults to localhost for dev; a localhost value in production is rejected
  // below so a misconfigured deploy fails fast instead of shipping dead localhost links.
  APP_BASE_URL: z.string().url().default('http://localhost:8080'),
}).superRefine((cfg, ctx) => {
  if (cfg.NODE_ENV === 'production' && /\/\/(localhost|127\.0\.0\.1)\b/.test(cfg.APP_BASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APP_BASE_URL'],
      message: 'must be the real public URL in production (not localhost)',
    });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

export const CONFIG = Symbol('APP_CONFIG');

/**
 * Validates process.env and returns typed config. Throws a readable aggregate
 * error naming every missing/invalid var. Call at the very start of bootstrap.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadSecretsFromFiles(env);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
