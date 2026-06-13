import { readFileSync } from 'node:fs';

/**
 * Docker-secrets support: for any env var FOO, if FOO_FILE points at a readable
 * file, its trimmed contents become FOO. Lets secrets be mounted as files
 * instead of plain env in production.
 */
export function loadSecretsFromFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.endsWith('_FILE') || !value) continue;
    const target = key.slice(0, -'_FILE'.length);
    try {
      env[target] = readFileSync(value, 'utf8').trim();
    } catch {
      // Leave as-is; config validation will report a missing target if required.
    }
  }
}
