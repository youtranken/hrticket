-- Đơn 12 (3/7/2026): split the daily digest into two ADMIN-ONLY sections with their
-- own thresholds — (1) pool tickets nobody claimed for >= pool_unclaimed_days,
-- (2) assigned tickets still unfinished past overdue_days. The send time gains a
-- minute component (default 08:30 VN). Members/TLs no longer receive digest mail;
-- the in-app overdue red badge is their signal.
ALTER TABLE "reminder_config" ADD COLUMN IF NOT EXISTS "digest_minute" integer NOT NULL DEFAULT 30;
ALTER TABLE "reminder_config" ADD COLUMN IF NOT EXISTS "pool_unclaimed_days" integer NOT NULL DEFAULT 2;
