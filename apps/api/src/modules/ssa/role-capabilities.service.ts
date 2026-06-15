import {
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withActor, systemActor, type DbTx } from '../../infra/db/with-actor';
import { roleCapabilities } from '../../infra/db/schema';
import { writeAudit } from '../../infra/audit/audit';
import type { SessionUser } from '../auth/session.service';
import {
  CAP_ROLES,
  CAPABILITIES,
  type CapRole,
  type Capability,
  isCapRole,
  isCapability,
  isLocked,
  defaultAllowed,
} from './capability-catalog';

export interface CapabilityCell {
  role: CapRole;
  allowed: boolean;
  locked: boolean;
}
export interface CapabilityRow {
  capability: Capability;
  cells: CapabilityCell[];
}
export interface CapabilityMatrix {
  roles: readonly CapRole[];
  rows: CapabilityRow[];
}

const CACHE_TTL_MS = 60_000; // A.9 — guards may read with a short cache.

/**
 * Story 9.4 (FR55/FR72) — SSA-only runtime editor for the role × capability matrix.
 * Reads are served from a 60s cache (rebuilt on every write); /me reads the table
 * directly so a toggle is visible on the user's next request (≤60s, AC1). Locked
 * cells (anti-self-lock + SSA full-access) are refused even on a direct API call (AC3).
 */
@Injectable()
export class RoleCapabilitiesService {
  private cache: { at: number; allowed: Map<CapRole, Set<Capability>> } | null = null;

  /** Full matrix for the editor UI (every role × every catalog capability). */
  async getMatrix(): Promise<CapabilityMatrix> {
    const allowed = await this.loadAllowed();
    const rows: CapabilityRow[] = CAPABILITIES.map((capability) => ({
      capability,
      cells: CAP_ROLES.map((role) => ({
        role,
        allowed: allowed.get(role)?.has(capability) ?? false,
        locked: isLocked(role, capability),
      })),
    }));
    return { roles: CAP_ROLES, rows };
  }

  /** Cached allowed-set for a role (for future capability guards, A.9). */
  async getAllowed(role: CapRole): Promise<Set<Capability>> {
    const allowed = await this.loadAllowed();
    return allowed.get(role) ?? new Set();
  }

  async setCapability(
    actor: SessionUser,
    roleRaw: string,
    capabilityRaw: string,
    allowed: boolean,
  ): Promise<{ ok: true }> {
    if (actor.role !== 'ssa') throw new ForbiddenException(); // AC2 — only SSA
    if (!isCapRole(roleRaw)) throw new UnprocessableEntityException('Unknown role');
    if (!isCapability(capabilityRaw)) throw new UnprocessableEntityException('Unknown capability');
    const role = roleRaw;
    const capability = capabilityRaw;
    // AC3 — locked cells can never change, even via a direct API call.
    if (isLocked(role, capability)) {
      throw new UnprocessableEntityException('This capability is locked and cannot be changed');
    }
    await withActor(systemActor, async (tx) => {
      const before = await this.cellValue(tx, role, capability);
      await this.upsert(tx, role, capability, allowed);
      await writeAudit(tx, {
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'role_capability.changed',
        objectType: 'role_capability',
        objectId: `${role}:${capability}`,
        oldValue: { allowed: before },
        newValue: { allowed },
      });
    });
    this.cache = null; // bust → effective immediately, well within the 60s window
    return { ok: true as const };
  }

  /** Reset the whole matrix to the PRD §2 defaults (AC4). */
  async restoreDefaults(actor: SessionUser): Promise<{ ok: true }> {
    if (actor.role !== 'ssa') throw new ForbiddenException();
    await withActor(systemActor, async (tx) => {
      for (const role of CAP_ROLES) {
        for (const capability of CAPABILITIES) {
          await this.upsert(tx, role, capability, defaultAllowed(role, capability));
        }
      }
      await writeAudit(tx, {
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'role_capability.reset',
        objectType: 'role_capability',
        objectId: 'all',
        oldValue: null,
        newValue: { reset: 'PRD-default' },
      });
    });
    this.cache = null;
    return { ok: true as const };
  }

  // ── internals ───────────────────────────────────────────────────────────────
  private async loadAllowed(): Promise<Map<CapRole, Set<Capability>>> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.allowed;
    const allowed = await withActor(systemActor, async (tx) => {
      const rows = await tx
        .select({
          role: roleCapabilities.role,
          capability: roleCapabilities.capability,
          allowed: roleCapabilities.allowed,
        })
        .from(roleCapabilities);
      const map = new Map<CapRole, Set<Capability>>();
      for (const r of CAP_ROLES) map.set(r, new Set());
      for (const row of rows) {
        if (row.allowed && isCapRole(row.role) && isCapability(row.capability)) {
          map.get(row.role)!.add(row.capability);
        }
      }
      return map;
    });
    this.cache = { at: now, allowed };
    return allowed;
  }

  private async cellValue(tx: DbTx, role: CapRole, capability: Capability): Promise<boolean> {
    const [row] = await tx
      .select({ allowed: roleCapabilities.allowed })
      .from(roleCapabilities)
      .where(and(eq(roleCapabilities.role, role), eq(roleCapabilities.capability, capability)));
    return row?.allowed ?? false;
  }

  private async upsert(tx: DbTx, role: CapRole, capability: Capability, allowed: boolean): Promise<void> {
    await tx
      .insert(roleCapabilities)
      .values({ role, capability, allowed })
      .onConflictDoUpdate({
        target: [roleCapabilities.role, roleCapabilities.capability],
        set: { allowed },
      });
  }
}
