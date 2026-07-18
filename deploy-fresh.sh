#!/usr/bin/env bash
# ============================================================================
# deploy-fresh.sh — Dựng prod TỪ ĐẦU bằng 1 lệnh (dùng khi ./data còn trống).
#
#   ./deploy-fresh.sh /home/hr/hris-prod-2026-07-17.dump
#
# Làm tuần tự: kiểm tra -> bật postgres -> tạo role app -> restore dump ->
# build & bật cả stack -> tự kiểm chứng. Dừng ngay nếu có bước sai.
#
# Cập nhật code về sau KHÔNG dùng script này — dùng ./update.sh (không mất data).
# ============================================================================
set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env"
DUMP="${1:-}"
PG=app-postgres-1

ok()   { printf '\n\033[1;32m✓ %s\033[0m\n' "$*"; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ─── 0) Kiểm tra đầu vào ────────────────────────────────────────────────────
step "0/6  Kiểm tra điều kiện"
[ -f docker-compose.prod.yml ] || die "Không thấy docker-compose.prod.yml — chạy script TỪ TRONG thư mục repo (cd /home/hr/hrticket)."
[ -f .env ] || die "Thiếu .env trong thư mục này. Copy .env vào /home/hr/hrticket/.env rồi chạy lại."
[ -f ../pmh.com.vn/fullchain.pem ] || die "Thiếu cert ../pmh.com.vn/fullchain.pem (phải NGANG HÀNG với repo, tức /home/hr/pmh.com.vn/)."
[ -f ../pmh.com.vn/private.key ]  || die "Thiếu ../pmh.com.vn/private.key."
[ -n "$DUMP" ] || die "Chưa truyền đường dẫn dump. Ví dụ: ./deploy-fresh.sh /home/hr/hris-prod-2026-07-17.dump"
[ -f "$DUMP" ] || die "Không thấy file dump: $DUMP"

# Không cho chạy đè lên DB đã có dữ liệu (tránh restore chồng gây hỏng).
if [ -d ./data/pgdata ] && [ -n "$(ls -A ./data/pgdata 2>/dev/null || true)" ]; then
  die "./data/pgdata đã có dữ liệu. Script này CHỈ dùng khi trống.
       Muốn làm lại sạch: '$COMPOSE down' rồi 'sudo rm -rf ./data/pgdata' (MẤT dữ liệu hiện tại — backup trước!)."
fi

$COMPOSE config >/dev/null || die ".env hoặc compose có lỗi (xem thông báo trên). Kiểm tra .env không dính BOM/CRLF."
ok "Điều kiện đủ. Dump: $DUMP"

# ─── 1) Postgres, đợi healthy ───────────────────────────────────────────────
step "1/6  Bật Postgres và đợi sẵn sàng"
$COMPOSE up -d postgres
tries=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG" 2>/dev/null || echo none)" = "healthy" ]; do
  tries=$((tries+1)); [ "$tries" -gt 60 ] && die "Postgres không healthy sau 2 phút. Xem: $COMPOSE logs postgres"
  echo "  ...chờ postgres ($tries)"; sleep 2
done
ok "Postgres healthy"

# ─── 2) Role app (idempotent) ───────────────────────────────────────────────
step "2/6  Tạo role 'app'"
docker exec "$PG" psql -U hris -d hris -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app') THEN CREATE ROLE app NOLOGIN; END IF; END \$\$;"
ok "Role app sẵn sàng"

# ─── 3) Restore dump ────────────────────────────────────────────────────────
step "3/6  Restore dump vào DB"
docker cp "$DUMP" "$PG":/tmp/dump
docker exec "$PG" pg_restore --no-owner --no-privileges -U hris -d hris /tmp/dump || \
  echo "  (pg_restore in vài warning là bình thường — kiểm số user ở bước dưới)"
USERS=$(docker exec "$PG" psql -U hris -d hris -t -A -c "SELECT count(*) FROM users;")
[ "$USERS" -gt 0 ] || die "Restore xong nhưng bảng users trống ($USERS). Dump có vấn đề — dừng lại."
ok "Restore OK — $USERS user trong DB"

# ─── 4) Build + bật cả stack ────────────────────────────────────────────────
step "4/6  Build & bật cả stack (lần đầu mất 5-10 phút)"
$COMPOSE up -d --build
ok "Đã bật api/worker/web"

# ─── 5) Đợi migrate xong ────────────────────────────────────────────────────
step "5/6  Đợi service migrate áp schema"
tries=0
until [ "$(docker inspect -f '{{.State.Status}}' app-migrate-1 2>/dev/null || echo none)" = "exited" ]; do
  tries=$((tries+1)); [ "$tries" -gt 60 ] && die "migrate chưa xong sau 2 phút. Xem: $COMPOSE logs migrate"
  echo "  ...chờ migrate ($tries)"; sleep 2
done
MIG_CODE=$(docker inspect -f '{{.State.ExitCode}}' app-migrate-1)
[ "$MIG_CODE" = "0" ] || die "migrate lỗi (exit $MIG_CODE). Xem: $COMPOSE logs migrate"
ok "migrate xong (exit 0)"

# ─── 6) Kiểm chứng ──────────────────────────────────────────────────────────
step "6/6  Kiểm chứng"
SUPER=$(docker exec "$PG" psql -U hris -d hris -t -A -c "SELECT rolsuper FROM pg_roles WHERE rolname='app';")
[ "$SUPER" = "f" ] || die "role app đang là superuser (rolsuper=$SUPER) — RLS bị vô hiệu, phân quyền hỏng!"
ok "role app không phải superuser (RLS an toàn)"
$COMPOSE ps

printf '\n\033[1;32m════════════════════════════════════════════\n'
printf '  DEPLOY XONG. Còn 2 việc thủ công:\n'
printf '  1) Trỏ DNS hrticket.pmh.com.vn về máy này\n'
printf '  2) Vào https://hrticket.pmh.com.vn -> /admin/email-connection\n'
printf '     -> nhập lại App Password cho CẢ 2 project (vì secret mới)\n'
printf '════════════════════════════════════════════\033[0m\n'
