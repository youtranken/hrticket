#!/usr/bin/env bash
# ============================================================================
# clear-prod-keep-ssa.sh — Xóa SẠCH dữ liệu vận hành để BÀN GIAO prod sạch,
# CHỈ giữ lại tài khoản SSA + cấu hình nền (project, category, capability,
# template, tag, reminder/project settings). Ticket đánh số lại từ 1.
#
#   ./clear-prod-keep-ssa.sh          # XEM TRƯỚC (dry-run) — KHÔNG xóa gì
#   ./clear-prod-keep-ssa.sh --yes    # THỰC SỰ xóa
#
# GIỮ LẠI:  projects, categories(+keywords), role_capabilities, email_templates,
#           reminder_config, project_settings, tags(+keywords), migrations, SSA.
# XÓA:      users (trừ SSA), tickets + tin nhắn/đính kèm/tag/participant/draft,
#           inbox/outbox/imap_cursor, notifications, audit_log, sessions,
#           email_connections (credential test), allow/blocklist, junk_rules,
#           reply_templates, auto-assign, các bảng log/counter tạm.
#           project_counters -> last_no = 0.
#
# An toàn: chạy trong 1 transaction (lỗi giữa chừng -> rollback, không mất nửa vời)
# và DỪNG nếu không tìm thấy SSA (tránh khóa hết hệ thống).
# ============================================================================
set -euo pipefail

PG=${PG_CONTAINER:-app-postgres-1}
DB=${DB_NAME:-hris}
DB_USER=${DB_USER:-hris}
PSQL=(docker exec -i "$PG" psql -U "$DB_USER" -d "$DB" -v ON_ERROR_STOP=1)

echo "==> DB: $DB @ container $PG"
echo "==> Trước khi xóa:"
"${PSQL[@]}" -c "SELECT
  (SELECT count(*) FROM users)                          AS users,
  (SELECT count(*) FROM users WHERE role='ssa')         AS ssa,
  (SELECT count(*) FROM tickets)                        AS tickets,
  (SELECT count(*) FROM notifications)                  AS notifs,
  (SELECT count(*) FROM email_connections)              AS email_conns;"

if [ "${1:-}" != "--yes" ]; then
  echo
  echo "*** DRY-RUN: CHƯA xóa gì. Chạy lại với  --yes  để thực sự xóa. ***"
  exit 0
fi

echo
echo "==> Đang xóa (transaction)..."
"${PSQL[@]}" <<'SQL'
BEGIN;

-- Chốt chặn: phải còn ít nhất 1 SSA, nếu không thì DỪNG (đừng khóa hết hệ thống).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE role='ssa') THEN
    RAISE EXCEPTION 'Không tìm thấy tài khoản SSA — dừng lại để tránh khóa toàn bộ.';
  END IF;
END $$;

-- Xóa toàn bộ dữ liệu vận hành. CASCADE + RESTART IDENTITY để id bắt đầu lại từ 1.
-- (Không bảng cấu hình nào tham chiếu các bảng dưới đây, nên CASCADE không đụng chúng.)
TRUNCATE
  view_log, attachments, ticket_tags, ticket_link, participants, drafts,
  ticket_messages, tickets,
  reopen_notice_log, snooze_reminder_log, overdue_escalation_log,
  inbox_messages, outbox, imap_cursor,
  mail_bomb_alert_log, mail_bomb_counters, email_connections,
  assign_cursors, auto_assign_members, auto_assign_config,
  user_group_membership, allowlist, blocklist, junk_rules, reply_templates,
  notifications, sessions, otp_codes, password_reset_tokens, login_attempts,
  idempotency_keys, digest_log, audit_log, worker_heartbeats
  RESTART IDENTITY CASCADE;

-- Giữ lại DUY NHẤT tài khoản SSA.
DELETE FROM users WHERE role <> 'ssa';

-- Ticket đánh số lại từ đầu.
UPDATE project_counters SET last_no = 0;

COMMIT;
SQL

echo
echo "==> Sau khi xóa:"
"${PSQL[@]}" -c "SELECT
  (SELECT count(*) FROM users)                 AS users_con_lai,
  (SELECT string_agg(email, ', ') FROM users)  AS ai,
  (SELECT count(*) FROM tickets)               AS tickets,
  (SELECT count(*) FROM notifications)         AS notifs,
  (SELECT count(*) FROM email_connections)     AS email_conns;"
echo
echo "✓ XONG — prod đã sạch, chỉ còn tài khoản SSA + cấu hình nền."
echo "  Lưu ý: email_connections đã bị xóa -> vào /admin/email-connection nhập lại"
echo "  mailbox thật cho từng project trước khi dùng."
