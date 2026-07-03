-- Stranger-approval removal: every thread address now joins as an ACTIVE participant
-- (reply-all follows the latest mail with no human approval step). Flip the rows that
-- were parked awaiting approval; explicit rejections are left untouched.
UPDATE "participants" SET "status" = 'active' WHERE "status" = 'pending_approval';
