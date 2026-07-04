/**
 * Story 9.4 (FR55) — the canonical role × capability catalog. The four roles are
 * FIXED (never add/remove); SSA toggles capability cells at runtime. seed.ts derives
 * its role_capabilities rows FROM this catalog, so "Restore defaults" and a fresh
 * seed always agree.
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

/**
 * Allowed-by-default capabilities per role. Capabilities are ENFORCED at the API
 * (CapabilityGuard), so the defaults must mirror the ACTUAL baseline model — open
 * claim (every role claims from pool), assignee-first reply (any role replies while
 * holding the ticket), TL/Admin/SSA assign + read logs — not just the PRD §2
 * "highlight" diagonal. With these defaults the guard denies nothing that the role
 * gates already allowed; an SSA toggling a cell OFF is what removes an ability.
 * SSA's config/matrix powers ride the two LOCKED cells; config endpoints accept
 * config.manage OR config.manage_all (see the guard mappings).
 */
export const DEFAULT_ALLOWED: Record<CapRole, Capability[]> = {
  member: ['ticket.reply', 'ticket.claim'],
  team_lead: ['ticket.reply', 'ticket.claim', 'ticket.assign_others', 'log.read_group'],
  admin: [
    'ticket.reply',
    'ticket.claim',
    'ticket.assign_others',
    'log.read_group',
    'config.manage',
    'user.manage',
  ],
  ssa: [...CAPABILITIES],
};

/**
 * Which roles a capability can APPLY to at all. Cells outside this map are DEAD
 * toggles — the services hard-block the role regardless of the matrix (e.g. a
 * member never reads the audit log, only SSA edits this matrix, manual assign is
 * TL-in-group/Admin in assertCanAssign) — so the editor locks them OFF instead of
 * offering a switch that grants nothing (owner's call, 4/7/2026).
 */
export const APPLICABLE: Record<Capability, readonly CapRole[]> = {
  'ticket.reply': CAP_ROLES,
  'ticket.claim': CAP_ROLES,
  'ticket.assign_others': ['team_lead', 'admin', 'ssa'],
  'log.read_group': ['team_lead', 'admin', 'ssa'],
  'config.manage': ['admin', 'ssa'],
  'user.manage': ['admin', 'ssa'],
  'role.edit_capabilities': ['ssa'],
  'config.manage_all': ['ssa'],
};

/**
 * Immutable cells (🔒), two kinds:
 *  - The ENTIRE SSA column is locked ON: SSA is the super-admin and always holds
 *    every capability — nobody can strip it (anti-self-lock: role.edit_capabilities
 *    can never leave SSA; there is no state without a full-access role).
 *  - Non-APPLICABLE cells are locked OFF (dead toggles, see above).
 * Category-group VISIBILITY is intentionally NOT in the catalog — it is RLS, not a
 * capability, so it can never be toggled here.
 */
export const LOCKED: ReadonlyArray<{ role: CapRole; capability: Capability }> =
  CAPABILITIES.flatMap((capability) =>
    CAP_ROLES.filter((role) => role === 'ssa' || !APPLICABLE[capability].includes(role)).map(
      (role) => ({ role, capability }),
    ),
  );

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
