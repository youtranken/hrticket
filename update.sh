#!/usr/bin/env bash
# ============================================================================
# update.sh — Cập nhật code mới từ GitHub, KHÔNG mất dữ liệu.
#
#   ./update.sh
#
# Dùng khi đã deploy xong và có code mới trên GitHub. Chỉ git pull + build lại.
# Dữ liệu trong ./data (DB + attachments) KHÔNG bị đụng tới.
# ============================================================================
set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f docker-compose.prod.yml ] || die "Chạy TỪ TRONG thư mục repo (cd /home/hr/hrticket)."
[ -f .env ] || die "Thiếu .env."

step "1/3  Kéo code mới từ GitHub"
git pull origin master

step "2/3  Build lại image có thay đổi & bật lại"
# migrate tự áp migration MỚI (nếu có); dữ liệu trong ./data giữ nguyên.
$COMPOSE up -d --build

step "3/3  Trạng thái"
$COMPOSE ps
echo
echo "Migration vừa áp (nếu có):"
$COMPOSE logs migrate 2>/dev/null | tail -15

printf '\n\033[1;32m✓ Cập nhật xong. Dữ liệu trong ./data KHÔNG bị đụng tới.\033[0m\n'
