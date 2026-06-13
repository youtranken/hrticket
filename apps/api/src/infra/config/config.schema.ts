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
