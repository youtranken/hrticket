/**
 * Story 9.4 (FR55) — the canonical role × capability catalog. The four roles are
 * FIXED (never add/remove); SSA toggles capability cells at runtime. The default
 * matrix mirrors the PRD §2 seed (infra/db/seed.ts CAPABILITIES) so "Restore
 * defaults" reproduces exactly that state.
 *
 * Capability LABELS live in the FE i18n (`cap.<key>` / `cap.<key>.desc`) — this BE
 * catalog ships keys + structure only (CLAUDE.md: Vietnamese only in vi.json/DB).
 */
export const CAP_ROLES = ['member', 'team_lead', 'admin', 'ssa'] as const;
export type CapRole = (typeof CAP_ROLES)[number];

export const CAPABILITIES = [
  'ticket.reply',
  'ticket.claim',
  'ticket.assign_others',
  'log.read_group',
  'config.manage',
  'user.manage',
  'role.edit_capabilities',
  'config.manage_all',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Allowed-by-default capabilities per role (PRD §2 = the seed). */
export const DEFAULT_ALLOWED: Record<CapRole, Capability[]> = {
  member: ['ticket.reply', 'ticket.claim'],
  team_lead: ['ticket.assign_others', 'log.read_group'],
  admin: ['config.manage', 'user.manage'],
  ssa: ['role.edit_capabilities', 'config.manage_all'],
};

/**
 * Immutable cells (🔒). Locked ON so the system can never be bricked:
 *  - ssa · role.edit_capabilities → only SSA edits the matrix; turning it off would
 *    lock EVERYONE out of capability editing forever (anti-self-lock).
 *  - ssa · config.manage_all → SSA's full-access power.
 * Category-group VISIBILITY is intentionally NOT in the catalog — it is RLS, not a
 * capability, so it can never be toggled here.
 */
export const LOCKED: ReadonlyArray<{ role: CapRole; capability: Capability }> = [
  { role: 'ssa', capability: 'role.edit_capabilities' },
  { role: 'ssa', capability: 'config.manage_all' },
];

export function isCapRole(v: string): v is CapRole {
  return (CAP_ROLES as readonly string[]).includes(v);
}
export function isCapability(v: string): v is Capability {
  return (CAPABILITIES as readonly string[]).includes(v);
}
export function isLocked(role: CapRole, capability: Capability): boolean {
  return LOCKED.some((l) => l.role === role && l.capability === capability);
}
export function defaultAllowed(role: CapRole, capability: Capability): boolean {
  return DEFAULT_ALLOWED[role].includes(capability);
}
