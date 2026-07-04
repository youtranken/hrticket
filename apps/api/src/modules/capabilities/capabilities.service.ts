import { Injectable } from '@nestjs/common';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { roleCapabilities } from '../../infra/db/schema';
import { CAP_ROLES, type CapRole, type Capability, isCapRole, isCapability } from './capability-catalog';

const CACHE_TTL_MS = 60_000; // A.9 — guards read through a short cache.

/**
 * Cached read side of the role × capability matrix, shared by CapabilityGuard (every
 * decorated request) and the SSA editor. Lives in its own LEAF module (no imports)
 * so auth/tickets/admin/audit can all pull it in without a DI cycle. The editor
 * busts the cache on every write, so a toggle is effective on the next request.
 */
@Injectable()
export class CapabilitiesService {
  private cache: { at: number; allowed: Map<CapRole, Set<Capability>> } | null = null;

  /** Allowed capability set for a role (60s cache, busted on matrix writes). */
  async getAllowed(role: CapRole): Promise<Set<Capability>> {
    const allowed = await this.loadAllowed();
    return allowed.get(role) ?? new Set();
  }

  /** True when the role currently holds ANY of the given capabilities. */
  async hasAny(role: string, caps: readonly Capability[]): Promise<boolean> {
    if (!isCapRole(role)) return false;
    const allowed = await this.getAllowed(role);
    return caps.some((c) => allowed.has(c));
  }

  /** Called by the SSA editor after every matrix write. */
  bust(): void {
    this.cache = null;
  }

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
}
