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
} from '../capabilities/capability-catalog';
import { CapabilitiesService } from '../capabilities/capabilities.service';

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

/**
 * Story 9.4 (FR55/FR72) — SSA-only runtime editor for the role × capability matrix.
 * Reads go through CapabilitiesService's 60s cache (shared with CapabilityGuard),
 * busted on every write so a toggle is enforced on the next request (AC1). Locked
 * cells (anti-self-lock + SSA full-access) are refused even on a direct API call (AC3).
 */
@Injectable()
export class RoleCapabilitiesService {
  constructor(private readonly caps: CapabilitiesService) {}

  /** Full matrix for the editor UI (every role × every catalog capability). */
  async getMatrix(): Promise<CapabilityMatrix> {
    const byRole = new Map<CapRole, Set<Capability>>();
    for (const role of CAP_ROLES) byRole.set(role, await this.caps.getAllowed(role));
    const rows: CapabilityRow[] = CAPABILITIES.map((capability) => ({
      capability,
      cells: CAP_ROLES.map((role) => ({
        role,
        allowed: byRole.get(role)!.has(capability),
        locked: isLocked(role, capability),
      })),
    }));
    return { roles: CAP_ROLES, rows };
  }

  /** Cached allowed-set for a role (delegates to the shared guard-side cache). */
  async getAllowed(role: CapRole): Promise<Set<Capability>> {
    return this.caps.getAllowed(role);
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
        projectId: actor.projectId,
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'role_capability.changed',
        objectType: 'role_capability',
        objectId: `${role}:${capability}`,
        oldValue: { allowed: before },
        newValue: { allowed },
      });
    });
    this.caps.bust(); // effective on the next request — the guard re-reads at once
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
        projectId: actor.projectId,
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'role_capability.reset',
        objectType: 'role_capability',
        objectId: 'all',
        oldValue: null,
        newValue: { reset: 'PRD-default' },
      });
    });
    this.caps.bust();
    return { ok: true as const };
  }

  // ── internals ───────────────────────────────────────────────────────────────
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
