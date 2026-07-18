import { promises as fs, createReadStream, type ReadStream } from 'node:fs';
import * as path from 'node:path';

/** Read per call (not at import) so tests can point it at a temp dir. */
export function storageRoot(): string {
  return process.env.ATTACHMENT_STORAGE_ROOT ?? './attachments';
}

/** Relative storage path keyed by UUID — original filename is NEVER part of the path. */
export function storagePathFor(projectId: number, uuid: string, when: Date): string {
  const yyyy = String(when.getUTCFullYear());
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  return path.posix.join(String(projectId), yyyy, mm, uuid);
}

/** Resolve a relative path against the storage root, refusing anything that escapes it. */
function resolveSafe(relPath: string): string {
  const rootAbs = path.resolve(storageRoot());
  const abs = path.resolve(rootAbs, relPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`path escapes storage root: ${relPath}`);
  }
  return abs;
}

export async function writeFile(relPath: string, buf: Buffer): Promise<void> {
  const abs = resolveSafe(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
}

export async function readFile(relPath: string): Promise<Buffer> {
  return fs.readFile(resolveSafe(relPath));
}

export async function statFile(relPath: string): Promise<{ exists: boolean; size: number }> {
  try {
    const s = await fs.stat(resolveSafe(relPath));
    return { exists: true, size: s.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

/**
 * Open a streaming read of a stored file (Story 8.1 — HTTP Range). Resolves the
 * path under the storage root first (path-traversal safe), then returns an
 * fs.ReadStream so the file is NEVER buffered fully into RAM (AC4). `start`/`end`
 * are inclusive byte offsets (RFC 7233 semantics); omit both for the whole file.
 * Additive helper — does not touch readFile/statFile/writeFile behavior.
 */
export function createReadStreamFor(
  relPath: string,
  range?: { start: number; end: number },
): ReadStream {
  const abs = resolveSafe(relPath);
  return range ? createReadStream(abs, { start: range.start, end: range.end }) : createReadStream(abs);
}

export async function deleteFile(relPath: string): Promise<void> {
  try {
    await fs.unlink(resolveSafe(relPath));
  } catch {
    /* already gone */
  }
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPct: number; // 0..100, rounded
  freePct: number; // 0..100, rounded
}

/** Walk up to the first directory that exists. The storage root may not be created
 *  until the first file is written (fresh container), and `statfs` on a missing path
 *  throws ENOENT — but any existing path on the same mount reports the same figures. */
async function firstExistingAncestor(start: string): Promise<string> {
  let dir = path.resolve(start);
  // Bound the climb by the number of path segments (terminates at the root).
  for (let i = 0; i < 64; i++) {
    try {
      await fs.access(dir);
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return dir; // reached the filesystem root
      dir = parent;
    }
  }
  return dir;
}

/**
 * Filesystem usage of the storage root (Story 8.4 — disk monitor + config bar).
 * `bavail` (blocks available to a non-privileged user) is the honest "free" figure
 * the app can actually write into. Resolves to the nearest existing ancestor first
 * so a not-yet-created storage dir doesn't ENOENT. Additive — leaves other fns alone.
 */
export async function diskUsage(): Promise<DiskUsage> {
  const target = await firstExistingAncestor(storageRoot());
  const s = await fs.statfs(target);
  const totalBytes = s.blocks * s.bsize;
  const freeBytes = s.bavail * s.bsize;
  const usedBytes = totalBytes - freeBytes;
  const usedPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
  return { totalBytes, freeBytes, usedBytes, usedPct, freePct: 100 - usedPct };
}
