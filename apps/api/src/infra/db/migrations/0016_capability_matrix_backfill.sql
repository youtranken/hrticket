-- Story: capability enforcement (FR55). The role × capability matrix is now
-- ENFORCED at the API by CapabilityGuard, so the sparse PRD §2 "diagonal" seed must
-- be completed to mirror the actual baseline model (open-claim, assignee-first
-- reply, TL/Admin/SSA assign + read logs) — otherwise turning the guard on would
-- strip existing roles of abilities they already have. ON CONFLICT DO NOTHING
-- preserves any cell an SSA has already toggled explicitly.
INSERT INTO "role_capabilities" ("role", "capability", "allowed") VALUES
  ('team_lead', 'ticket.reply', true),
  ('team_lead', 'ticket.claim', true),
  ('admin', 'ticket.reply', true),
  ('admin', 'ticket.claim', true),
  ('admin', 'ticket.assign_others', true),
  ('admin', 'log.read_group', true),
  ('ssa', 'ticket.reply', true),
  ('ssa', 'ticket.claim', true),
  ('ssa', 'ticket.assign_others', true),
  ('ssa', 'log.read_group', true),
  ('ssa', 'user.manage', true)
ON CONFLICT ("role", "capability") DO NOTHING;
