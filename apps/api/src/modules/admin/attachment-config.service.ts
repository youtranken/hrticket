import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { withActor, systemActor, type DbTx } from '../../infra/db/with-actor';
import { projectSettings } from '../../infra/db/schema';
import { diskUsage, type DiskUsage } from '../../infra/storage/fs-storage';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';

/**
 * Extensions the magic-byte sniffer (email-engine/magic-bytes.ts) has a real
 * signature for. Allowing anything ELSE means the file is accepted on extension
 * alone (the sniffer can't verify it) — the UI surfaces that as a warning so the
 * admin knows. Mirrors the `SafeType` union; kept local so the shared sniffer file
 * stays untouched (lead ruling — do not add new signatures here).
 */
const KNOWN_SIGNATURE_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'mp3', 'mp4']);

export interface AttachmentConfigView {
  allowedExtensions: string[];
  capMb: number;
  autotag: { attachment: boolean; crosspost: boolean; autoreply: boolean };
  diskAlertPct: number;
  /** Extensions in the whitelist with no magic signature (extension-only check). */
  signatureWarning: string[];
  disk: DiskUsage;
}

export interface AttachmentConfigPatch {
  allowedExtensions?: string[];
  capMb?: number;
  autotag?: { attachment?: boolean; crosspost?: boolean; autoreply?: boolean };
  diskAlertPct?: number;
}

/**
 * Attachment policy config (Story 8.4, FR73/FR76/FR91). Reads/writes `project_settings`
 * hard-scoped to the caller's project; ingest (2.5) and upload (3.6) read those columns
 * live, so a change is effective immediately for both doors — no restart, no cache (AC1).
 * Every change is audited old→new (AC4).
 */
@Injectable()
export class AttachmentConfigService {
  async get(projectId: number): Promise<AttachmentConfigView> {
    const disk = await diskUsage();
    return withActor(systemActor, async (tx) => {
      const row = await this.load(tx, projectId);
      return this.toView(row, disk);
    });
  }

  async update(
    actor: SessionUser,
    projectId: number,
    patch: AttachmentConfigPatch,
  ): Promise<AttachmentConfigView> {
    const disk = await diskUsage();
    return withActor(systemActor, async (tx) => {
      const before = await this.load(tx, projectId);

      const set: Record<string, unknown> = {};
      if (patch.allowedExtensions !== undefined) {
        set.allowedExtensions = dedupeClean(patch.allowedExtensions);
      }
      if (patch.capMb !== undefined) set.attachmentCapMb = patch.capMb;
      if (patch.diskAlertPct !== undefined) set.diskAlertPct = patch.diskAlertPct;
      if (patch.autotag?.attachment !== undefined) set.autotagAttachment = patch.autotag.attachment;
      if (patch.autotag?.crosspost !== undefined) set.autotagCrosspost = patch.autotag.crosspost;
      if (patch.autotag?.autoreply !== undefined) set.autotagAutoreply = patch.autotag.autoreply;

      if (Object.keys(set).length) {
        await tx.update(projectSettings).set(set).where(eq(projectSettings.projectId, projectId));
      }

      const after = await this.load(tx, projectId);
      await writeAudit(tx, {
        projectId,
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'attachment_config.updated',
        objectType: 'attachment_config',
        objectId: String(projectId),
        oldValue: this.auditShape(before),
        newValue: this.auditShape(after),
      });
      return this.toView(after, disk);
    });
  }

  private async load(tx: DbTx, projectId: number) {
    const [row] = await tx
      .select()
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId));
    return row;
  }

  private toView(
    row: typeof projectSettings.$inferSelect | undefined,
    disk: DiskUsage,
  ): AttachmentConfigView {
    const allowed = row?.allowedExtensions ?? [];
    return {
      allowedExtensions: allowed,
      capMb: row?.attachmentCapMb ?? 50,
      autotag: {
        attachment: row?.autotagAttachment ?? true,
        crosspost: row?.autotagCrosspost ?? true,
        autoreply: row?.autotagAutoreply ?? true,
      },
      diskAlertPct: row?.diskAlertPct ?? 15,
      signatureWarning: allowed.filter((e) => !KNOWN_SIGNATURE_EXTENSIONS.has(e.toLowerCase())),
      disk,
    };
  }

  private auditShape(row: typeof projectSettings.$inferSelect | undefined) {
    return {
      allowedExtensions: row?.allowedExtensions ?? [],
      capMb: row?.attachmentCapMb,
      autotag: {
        attachment: row?.autotagAttachment,
        crosspost: row?.autotagCrosspost,
        autoreply: row?.autotagAutoreply,
      },
      diskAlertPct: row?.diskAlertPct,
    };
  }
}

function dedupeClean(exts: string[]): string[] {
  return [...new Set(exts.map((e) => e.trim().toLowerCase().replace(/^\./, '')).filter((e) => e.length > 0))];
}
