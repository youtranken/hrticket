-- Project owner's call (4/7/2026): the ENTIRE SSA column of the capability matrix
-- is locked ON — SSA always holds every capability and no toggle can strip it.
-- Unlike 0016 this UPDATES on conflict: the lock is an invariant, so any previously
-- toggled-off SSA cell must be forced back to allowed.
INSERT INTO "role_capabilities" ("role", "capability", "allowed")
SELECT 'ssa', c, true
FROM unnest(ARRAY[
  'ticket.reply',
  'ticket.claim',
  'ticket.assign_others',
  'log.read_group',
  'config.manage',
  'user.manage',
  'role.edit_capabilities',
  'config.manage_all'
]) AS c
ON CONFLICT ("role", "capability") DO UPDATE SET "allowed" = true;
