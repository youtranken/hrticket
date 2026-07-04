import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vi from './vi.json';
import en from './en.json';

/**
 * Story 11.2 — machine-enforced i18n integrity, both directions:
 *  1. KEY-PARITY: vi.json and en.json carry the exact same key set (add a key to
 *     one, forget the other → red).
 *  2. KEY-USAGE: every static `t('…')` referenced in src/ exists in the catalog
 *     (a typo or a deleted key → red, instead of a raw `xxx.yyy` leaking to the UI).
 * Dynamic keys (template literals, `t(variable)`) are out of scope here — the
 * FE-DT DOM sweep covers those at runtime.
 */
const viKeys = Object.keys(vi as Record<string, string>);
const enKeys = Object.keys(en as Record<string, string>);

describe('i18n key parity (vi ↔ en)', () => {
  it('every vi key has an en translation', () => {
    const missing = viKeys.filter((k) => !(k in (en as Record<string, string>)));
    expect(missing, `missing in en.json: ${missing.join(', ')}`).toEqual([]);
  });
  it('every en key has a vi translation', () => {
    const missing = enKeys.filter((k) => !(k in (vi as Record<string, string>)));
    expect(missing, `missing in vi.json: ${missing.join(', ')}`).toEqual([]);
  });
  it('no key has an empty value in either language', () => {
    const blank = [...viKeys, ...enKeys].filter(
      (k) => !(vi as Record<string, string>)[k]?.trim() || !(en as Record<string, string>)[k]?.trim(),
    );
    expect([...new Set(blank)]).toEqual([]);
  });
});

/** Recursively collect source files under src/, skipping tests + the catalogs. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Static keys: `t('key')` / `t("key")`, ignoring template literals + variables. */
function usedKeys(): Map<string, string> {
  const re = /\bt\(\s*(['"])([^'"]+?)\1/g;
  const found = new Map<string, string>();
  for (const file of sourceFiles('src')) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      if (!found.has(m[2]!)) found.set(m[2]!, file);
    }
  }
  return found;
}

describe('i18n key usage (every referenced key exists)', () => {
  it('all static t() keys are defined in the catalog', () => {
    const catalog = new Set(viKeys);
    const orphans: string[] = [];
    for (const [key, file] of usedKeys()) {
      if (!catalog.has(key)) orphans.push(`${key}  (${file})`);
    }
    expect(orphans, `unknown i18n keys referenced:\n${orphans.join('\n')}`).toEqual([]);
  });
});

describe('i18n no-unused-key (P2 #9 — the catalog carries no dead weight)', () => {
  it('every catalog key is referenced somewhere in src/', () => {
    // One big haystack: a key counts as used when it appears as a string literal
    // anywhere ('key' / "key" / `key`) — this also covers labelKey/descKey tables —
    // or when it matches a dynamic template prefix like t(`status.${s}`), or is an
    // i18next plural variant (_one/_other) of a used base key.
    const allSrc = sourceFiles('src')
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const dynPrefixes = [...allSrc.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)]
      .map((m) => m[1]!)
      .filter((p) => p.length > 0);
    const literallyUsed = (k: string) =>
      allSrc.includes(`'${k}'`) || allSrc.includes(`"${k}"`) || allSrc.includes('`' + k + '`');
    const used = (k: string): boolean => {
      if (literallyUsed(k)) return true;
      if (dynPrefixes.some((p) => k.startsWith(p))) return true;
      const plural = /^(.*)_(one|other)$/.exec(k);
      if (plural) return used(plural[1]!);
      return false;
    };
    const dead = viKeys.filter((k) => !used(k));
    expect(dead, `unused i18n keys (delete them or reference them):\n${dead.join('\n')}`).toEqual([]);
  });
});
