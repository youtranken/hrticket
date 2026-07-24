#!/bin/bash
# Restore the NEWEST backups/hris-full-*.tar.gz (produced by the `backup` service).
#
# Unpacks the single archive and loads all three parts into a Postgres target:
#   roles.sql   -> applied to the `postgres` DB ("role already exists" is harmless)
#   db.dump     -> pg_restore into a FRESHLY (re)created target database (clean restore)
#   attachments -> extracted onto the host at $ATTACH_DEST
#
# The target Postgres runs in a Docker container (prod postgres has no host port), so
# it is addressed via `docker exec`. This DROPS AND RECREATES the target database —
# stop the app first so nothing holds a connection:
#
#   cd /home/hr/hrticket
#   docker compose -f docker-compose.prod.yml stop api worker
#   ./scripts/restore-latest.sh
#   docker compose -f docker-compose.prod.yml up -d api worker
#
# NOTE: `.env` is NOT in the archive by design — the stack keeps using the .env already
# on the host. Without the ORIGINAL EMAIL_SECRET_KEY, mailbox App Passwords stored
# (encrypted) in the DB can't be decrypted; re-enter them in /admin/email-connection.
#
# Env (prod defaults shown):
#   BACKUP_DIR    /home/hr/hrticket/backups        where the archives live
#   PG_CONTAINER  app-postgres-1                    docker container of Postgres
#   PGUSER        hris                              superuser/owner
#   PGDATABASE    hris                              database to restore into
#   ATTACH_DEST   /home/hr/hrticket/data/attachments   host attachment dir
#   ARCHIVE       (unset)                           restore THIS file instead of newest
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/hr/hrticket/backups}"
PG_CONTAINER="${PG_CONTAINER:-app-postgres-1}"
PGUSER="${PGUSER:-hris}"
PGDATABASE="${PGDATABASE:-hris}"
ATTACH_DEST="${ATTACH_DEST:-/home/hr/hrticket/data/attachments}"

archive="${ARCHIVE:-$(ls -1t "$BACKUP_DIR"/hris-full-*.tar.gz 2>/dev/null | head -1 || true)}"
[ -n "$archive" ] || { echo "[restore] no hris-full-*.tar.gz in $BACKUP_DIR" >&2; exit 1; }
docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || { echo "[restore] container '$PG_CONTAINER' not found" >&2; exit 1; }

echo "[restore] archive: $archive"
echo "[restore] target : container=$PG_CONTAINER db=$PGDATABASE user=$PGUSER"
echo "[restore] attach : $ATTACH_DEST"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
tar xzf "$archive" -C "$work"
[ -f "$work/db.dump" ] || { echo "[restore] archive missing db.dump" >&2; exit 1; }
[ -f "$work/MANIFEST.txt" ] && { echo "[restore] manifest:"; sed 's/^/    /' "$work/MANIFEST.txt"; }

dex() { docker exec -i "$PG_CONTAINER" "$@"; }

# 1) Cluster roles (role `app`, ...). ON_ERROR_STOP=0: "already exists" is harmless.
if [ -s "$work/roles.sql" ]; then
  echo "[restore] applying roles.sql"
  dex psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=0 < "$work/roles.sql" >/dev/null 2>&1 || true
fi

# 2) Clean target DB (drop + recreate), then pg_restore into it.
echo "[restore] recreating database '$PGDATABASE' (clean)"
dex psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PGDATABASE' AND pid <> pg_backend_pid();" >/dev/null
dex psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $PGDATABASE;" >/dev/null
dex psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $PGDATABASE OWNER $PGUSER;" >/dev/null

echo "[restore] pg_restore db.dump -> $PGDATABASE"
dex pg_restore --no-owner --no-privileges -U "$PGUSER" -d "$PGDATABASE" < "$work/db.dump"

# 3) Attachments onto the host (clear the dir, keep the dir itself, then copy in).
echo "[restore] restoring attachments -> $ATTACH_DEST"
mkdir -p "$ATTACH_DEST"
find "$ATTACH_DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
[ -d "$work/attachments" ] && cp -a "$work/attachments/." "$ATTACH_DEST/" 2>/dev/null || true

# 4) Quick verification.
tables=$(dex psql -U "$PGUSER" -d "$PGDATABASE" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | tr -d '[:space:]')
approle=$(dex psql -U "$PGUSER" -d postgres -tAc \
  "SELECT count(*) FROM pg_roles WHERE rolname='app';" | tr -d '[:space:]')
files=$(find "$ATTACH_DEST" -type f 2>/dev/null | wc -l | tr -d '[:space:]')
echo "[restore] DONE — public tables=$tables  role app=$approle  attachment files=$files"
echo "[restore] start the app:  docker compose -f docker-compose.prod.yml up -d api worker"
