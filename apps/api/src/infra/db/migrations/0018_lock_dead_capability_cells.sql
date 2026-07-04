-- Owner's call (4/7/2026): non-APPLICABLE matrix cells are dead toggles (the
-- services hard-block the role regardless — member never reads audit, only SSA
-- edits the matrix, assign is TL/Admin territory). They are now LOCKED OFF in the
-- catalog, so force any stray allowed=true rows back to false (DO UPDATE — the
-- lock is an invariant, same as 0017 for the SSA column).
INSERT INTO "role_capabilities" ("role", "capability", "allowed") VALUES
  ('member', 'ticket.assign_others', false),
  ('member', 'log.read_group', false),
  ('member', 'config.manage', false),
  ('member', 'user.manage', false),
  ('member', 'role.edit_capabilities', false),
  ('member', 'config.manage_all', false),
  ('team_lead', 'config.manage', false),
  ('team_lead', 'user.manage', false),
  ('team_lead', 'role.edit_capabilities', false),
  ('team_lead', 'config.manage_all', false),
  ('admin', 'role.edit_capabilities', false),
  ('admin', 'config.manage_all', false)
ON CONFLICT ("role", "capability") DO UPDATE SET "allowed" = false;
