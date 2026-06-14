import { eq, sql } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import {
  categories,
  autoAssignConfig,
  assignCursors,
  tickets,
  notifications,
} from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';

export type AssignStrategy = 'round_robin' | 'least_load';

export type AutoAssignReason =
  | 'assigned'
  | 'pool_system_category' // "Khác" never auto-assigns (FR28/FR35)
  | 'pool_no_config'
  | 'pool_empty_roster'
  | 'pool_all_away';

export interface AutoAssignResult {
  assigneeId: string | null;
  strategy?: AssignStrategy;
  reason: AutoAssignReason;
}

interface RosterRow {
  userId: string;
  position: number;
  available: boolean; // not disabled AND not away (computed at read, VN date)
}

/** "Away right now" by VN calendar date, computed at read — no flip job (A.10). */
const AWAY_SQL = sql`(
  u.away_from IS NOT NULL
  AND (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= u.away_from
  AND (u.away_to IS NULL OR (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= u.away_to)
)`;

const OPEN_STATUSES = sql`('open','assigned','in_progress')`;

/**
 * Auto-assign a freshly-created ticket to a roster member (Story 4.2), IN the
 * create-ticket transaction (atomic with classification). Strategy comes from the
 * category's auto_assign_config:
 *  - round_robin: walk the ordered roster from the cursor, skipping away members,
 *    and advance the cursor (assign_cursors, FOR UPDATE — replaces a Redis INCR).
 *  - least_load: fewest OPEN tickets (Open/Assigned/In Progress only — Pending and
 *    closed don't count); ties broken by longest-idle (smallest max assigned_at,
 *    never-assigned first), then smallest user id — fully deterministic (A.10).
 *
 * The cursor row is locked FOR UPDATE up-front in BOTH strategies, so it doubles
 * as a per-category mutex: concurrent intakes for the same category serialize at
 * the assign step → no double-assign, no TOCTOU (NFR9). "Khác", a missing config,
 * an empty roster, or everyone away all fall through to the pool (assignee NULL).
 */
export async function autoAssign(
  tx: DbTx,
  input: { projectId: number; ticketId: string; ticketCode: string; categoryId: number },
): Promise<AutoAssignResult> {
  const { projectId, ticketId, ticketCode, categoryId } = input;

  // "Khác"/system category → always pool.
  const [cat] = await tx
    .select({ isSystem: categories.isSystem })
    .from(categories)
    .where(eq(categories.id, categoryId));
  if (cat?.isSystem) return { assigneeId: null, reason: 'pool_system_category' };

  const [cfg] = await tx
    .select({ id: autoAssignConfig.id, strategy: autoAssignConfig.strategy })
    .from(autoAssignConfig)
    .where(eq(autoAssignConfig.categoryId, categoryId));
  if (!cfg) return { assigneeId: null, reason: 'pool_no_config' };

  // Lock the cursor row (per-category mutex). DO UPDATE forces a row write-lock even
  // when the row already exists, so a concurrent first-assignment can't slip past with
  // no lock held (P2: an INSERT … DO NOTHING acquires no lock for the loser).
  const cursorRows = (await tx.execute(sql`
    INSERT INTO assign_cursors (category_id) VALUES (${categoryId})
    ON CONFLICT (category_id) DO UPDATE SET category_id = excluded.category_id
    RETURNING last_user_id
  `)) as unknown as Array<{ last_user_id: string | null }>;
  const lastUserId = cursorRows[0]?.last_user_id ?? null;

  // Ordered roster with availability computed at read.
  const roster = (await tx.execute(sql`
    SELECT m.user_id AS "userId", m.position AS position, u.disabled AS disabled,
           ${AWAY_SQL} AS is_away
    FROM auto_assign_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.config_id = ${cfg.id}
    ORDER BY m.position ASC, m.user_id ASC
  `)) as unknown as Array<{
    userId: string;
    position: number;
    disabled: boolean;
    is_away: boolean;
  }>;
  if (roster.length === 0) return { assigneeId: null, reason: 'pool_empty_roster' };

  const ordered: RosterRow[] = roster.map((r) => ({
    userId: r.userId,
    position: r.position,
    available: !r.disabled && !r.is_away,
  }));
  const candidates = ordered.filter((r) => r.available);
  if (candidates.length === 0) return { assigneeId: null, reason: 'pool_all_away' };

  let chosen: string;
  if (cfg.strategy === 'round_robin') {
    chosen = pickRoundRobin(ordered, lastUserId);
    // Advance the cursor ONLY for round-robin — writing a least-load winner here would
    // skew rotation if the strategy is later switched back to RR (P3).
    await tx
      .update(assignCursors)
      .set({ lastUserId: chosen })
      .where(eq(assignCursors.categoryId, categoryId));
  } else {
    chosen = await pickLeastLoad(tx, candidates.map((c) => c.userId), projectId);
  }

  await tx
    .update(tickets)
    .set({ assigneeId: chosen, status: 'assigned', assignedAt: new Date() })
    .where(eq(tickets.id, ticketId));

  await tx.insert(notifications).values({
    actorId: chosen,
    type: 'ticket_assigned',
    payload: JSON.stringify({ ticketId, ticketCode, categoryId, auto: true }),
  });

  await writeAudit(tx, {
    projectId,
    actorLabel: 'system:routing',
    action: 'ticket.auto_assigned',
    objectType: 'ticket',
    objectId: ticketId,
    newValue: { assigneeId: chosen, strategy: cfg.strategy },
  });

  return { assigneeId: chosen, strategy: cfg.strategy, reason: 'assigned' };
}

/** Next available member after the cursor, circularly (FR25). */
function pickRoundRobin(ordered: RosterRow[], lastUserId: string | null): string {
  const n = ordered.length;
  const lastIdx = lastUserId ? ordered.findIndex((r) => r.userId === lastUserId) : -1;
  for (let step = 1; step <= n; step++) {
    const cand = ordered[(lastIdx + step) % n]!;
    if (cand.available) return cand.userId;
  }
  // Unreachable: caller guaranteed ≥1 available candidate.
  return ordered.find((r) => r.available)!.userId;
}

/** Fewest open tickets; tie → longest idle (max assigned_at asc, nulls first) → id. */
async function pickLeastLoad(
  tx: DbTx,
  candidateIds: string[],
  projectId: number,
): Promise<string> {
  const ids = sql.join(
    candidateIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // Scope load + idle to THIS project (D5) — explicit, future-proof against id reuse.
  const rows = (await tx.execute(sql`
    SELECT u.id AS id,
      (SELECT count(*) FROM tickets t
         WHERE t.assignee_id = u.id AND t.project_id = ${projectId}
           AND t.status IN ${OPEN_STATUSES})::int AS load,
      (SELECT max(t.assigned_at) FROM tickets t
         WHERE t.assignee_id = u.id AND t.project_id = ${projectId}) AS last_assigned
    FROM users u
    WHERE u.id IN (${ids})
  `)) as unknown as Array<{ id: string; load: number; last_assigned: string | null }>;

  rows.sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    // Never-assigned (null) is the longest idle → first.
    const at = a.last_assigned ? Date.parse(a.last_assigned) : -Infinity;
    const bt = b.last_assigned ? Date.parse(b.last_assigned) : -Infinity;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : 1;
  });
  return rows[0]!.id;
}
