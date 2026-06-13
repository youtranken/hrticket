import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { and, eq, lt } from 'drizzle-orm';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { attachments } from '../../infra/db/schema';
import { statFile, storageRoot } from '../../infra/storage/fs-storage';

export interface RepairResult {
  stored: number;
  failed: number;
  orphanFiles: number;
}

async function walkRelFiles(rootAbs: string, dir = rootAbs): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkRelFiles(rootAbs, abs)));
    else out.push(path.relative(rootAbs, abs).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Self-healing for the write-before-commit protocol (A.4 / AC4). Two directions:
 *  - orphan ROW: a `pending` attachment older than the threshold whose file is
 *    missing/wrong-size → flip to `failed` (never a permanent `pending`); a present,
 *    right-sized file → `stored` (a crash between write and the flip).
 *  - orphan FILE: a file on disk with no DB row → counted (and logged) for cleanup.
 */
export async function repairAttachments(olderThanMs = 15 * 60 * 1000): Promise<RepairResult> {
  const cutoff = new Date(Date.now() - olderThanMs);
  let stored = 0;
  let failed = 0;

  const knownPaths = await withActor(systemActor, async (tx) => {
    const stale = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.status, 'pending'), lt(attachments.createdAt, cutoff)));
    for (const a of stale) {
      const st = await statFile(a.storagePath);
      const ok = st.exists && st.size === a.size;
      await tx
        .update(attachments)
        .set({ status: ok ? 'stored' : 'failed' })
        .where(eq(attachments.id, a.id));
      if (ok) stored += 1;
      else failed += 1;
    }
    const all = await tx.select({ p: attachments.storagePath }).from(attachments);
    return new Set(all.map((r) => r.p).filter(Boolean));
  });

  const rootAbs = path.resolve(storageRoot());
  const onDisk = await walkRelFiles(rootAbs);
  const orphanFiles = onDisk.filter((rel) => !knownPaths.has(rel)).length;

  return { stored, failed, orphanFiles };
}
