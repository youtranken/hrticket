import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { tags, ticketTags, projectSettings } from '../../infra/db/schema';
import type { TagKind } from '../../infra/db/schema';

/** Names of the system auto-tags (FR33). Seeded per project; toggled in 8.4. */
export const AUTO_TAG = {
  attachment: 'Attachment',
  crossPost: 'Cross-post',
  autoReply: 'Auto-reply',
} as const;

/** Look up a tag by name, creating it if absent (idempotent on (project,name)). */
export async function ensureTag(
  tx: DbTx,
  projectId: number,
  name: string,
  kind: TagKind = 'auto',
  color = '#fa8c16',
): Promise<number> {
  const [existing] = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.projectId, projectId), eq(tags.name, name)));
  if (existing) return existing.id;
  await tx
    .insert(tags)
    .values({ projectId, name, kind, color })
    .onConflictDoNothing({ target: [tags.projectId, tags.name] });
  const [row] = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.projectId, projectId), eq(tags.name, name)));
  return row!.id;
}

export async function addTicketTag(tx: DbTx, ticketId: string, tagId: number): Promise<void> {
  await tx.insert(ticketTags).values({ ticketId, tagId }).onConflictDoNothing();
}

export interface AutoTagSignals {
  hasStoredAttachment?: boolean;
  isAutoReply?: boolean;
  isCrossPost?: boolean;
}

/**
 * Apply signal-based + keyword-based auto-tags to a ticket (FR32/FR33). The three
 * signal tags (Attachment / Auto-reply / Cross-post) each obey a per-project
 * toggle (`project_settings`, managed in 8.4). Priority tags are applied purely by
 * keyword rule (`tag_keywords`, accent-insensitive like classify) — "priority is
 * just a tag, no time logic". Returns the tag names actually applied.
 */
export async function applyAutoTags(
  tx: DbTx,
  input: {
    projectId: number;
    ticketId: string;
    subject?: string;
    body?: string | null;
    signals: AutoTagSignals;
  },
): Promise<string[]> {
  const applied: string[] = [];
  const [settings] = await tx
    .select({
      attachment: projectSettings.autotagAttachment,
      crossPost: projectSettings.autotagCrosspost,
      autoReply: projectSettings.autotagAutoreply,
    })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, input.projectId));

  const addByName = async (name: string) => {
    await addTicketTag(tx, input.ticketId, await ensureTag(tx, input.projectId, name));
    if (!applied.includes(name)) applied.push(name);
  };

  if (input.signals.hasStoredAttachment && (settings?.attachment ?? true)) {
    await addByName(AUTO_TAG.attachment);
  }
  if (input.signals.isAutoReply && (settings?.autoReply ?? true)) {
    await addByName(AUTO_TAG.autoReply);
  }
  if (input.signals.isCrossPost && (settings?.crossPost ?? true)) {
    await addByName(AUTO_TAG.crossPost);
  }

  // Priority keyword rules (FR32). No toggle — a rule existing IS the opt-in.
  const haystack = `${input.subject ?? ''}\n${input.body ?? ''}`;
  const prio = (await tx.execute(sql`
    SELECT DISTINCT t.id AS id, t.name AS name
    FROM tag_keywords k
    JOIN tags t ON t.id = k.tag_id
    WHERE t.project_id = ${input.projectId}
      AND t.kind = 'priority'
      AND position(f_unaccent(lower(k.keyword)) IN f_unaccent(lower(${haystack}))) > 0
  `)) as unknown as Array<{ id: number; name: string }>;
  for (const p of prio) {
    await addTicketTag(tx, input.ticketId, Number(p.id));
    if (!applied.includes(p.name)) applied.push(p.name);
  }

  return applied;
}
