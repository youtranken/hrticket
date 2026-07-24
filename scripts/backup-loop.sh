#!/bin/bash
# Scheduled FULL backup — one file per run — running entirely INSIDE Docker (no host cron).
#
# Used by the `backup` service in docker-compose.prod.yml. Reuses the pinned
# postgres:18.4 image (same pg_dump version as the server — no version skew) and
# needs no extra tools. On startup it takes one backup immediately, then sleeps
# until BACKUP_HOUR every day.
#
# Each run produces ONE self-contained archive:
#     backups/hris-full-<date>.tar.gz
#   ├── db.dump        DB, CUSTOM format (pg_dump -Fc) — restore with pg_restore (§5).
#   ├── roles.sql      cluster roles (pg_dumpall --roles-only) — so a restore already
#   │                  has role `app` etc. without a manual CREATE ROLE.
#   ├── attachments/   the SAME dir the app uses (${ATTACHMENT_HOST_DIR}), stored as-is.
#   └── MANIFEST.txt   what's inside + when.
#
#   * NOT included by design: `.env` (POSTGRES_PASSWORD + SESSION/HMAC/ATTACHMENT/
#     EMAIL keys). Keep it off-site SEPARATELY — without EMAIL_SECRET_KEY the mailbox
#     App Passwords stored (encrypted) in the DB can't be decrypted after a restore.
#   * A run is atomic: it builds into a .tmp and renames on success, so a partial
#     archive is never left behind; a failed DB dump aborts the run and keeps prior
#     backups untouched.
#   * Files older than BACKUP_KEEP_DAYS are pruned.
#
# Env (set by the compose service): PGHOST PGUSER PGPASSWORD PGDATABASE
#   BACKUP_DIR (default /backups)  BACKUP_KEEP_DAYS (default 14)  BACKUP_HOUR (default 2)
set -uo pipefail

DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
HOUR="${BACKUP_HOUR:-2}"
ATTACH_SRC="/attachments"   # mounted read-only by the compose service

mkdir -p "$DIR"

run_backup() {
  local ts out tmp work
  ts="$(date +%F-%H%M)"
  out="$DIR/hris-full-$ts.tar.gz"
  tmp="$out.tmp"
  work="$DIR/.wip-$ts"   # staged on the backups volume (not container tmpfs) so big DBs fit
  mkdir -p "$work"

  echo "[backup] $(date '+%F %T %Z') — dumping DB (-Fc) → db.dump"
  if ! pg_dump -Fc -f "$work/db.dump"; then
    echo "[backup] DB dump FAILED — aborting this run, keeping previous backups" >&2
    rm -rf "$work"
    return 1
  fi

  # Cluster roles (role `app`, owner `hris`, …). Non-fatal: an old server without
  # superuser rights just skips it — the stack's rls-and-extras.sql recreates `app`.
  if ! pg_dumpall --roles-only > "$work/roles.sql" 2>/dev/null; then
    echo "[backup] warn: roles dump failed — restore may need a manual CREATE ROLE app" >&2
    : > "$work/roles.sql"
  fi

  {
    echo "created:     $(date '+%F %T %Z')"
    echo "db.dump:     pg_dump -Fc (database $PGDATABASE — full: schema + data + RLS)"
    echo "roles.sql:   pg_dumpall --roles-only (apply BEFORE pg_restore)"
    echo "attachments: verbatim copy of the app's attachment dir"
    echo "NOT here:    .env / secrets — keep them off-site separately"
  } > "$work/MANIFEST.txt"

  # Assemble ONE archive. Multiple -C switches avoid copying the (possibly large)
  # attachments tree: db.dump/roles.sql/MANIFEST from the work dir, attachments from /.
  local -a tar_args=(-C "$work" db.dump roles.sql MANIFEST.txt)
  if [ -d "$ATTACH_SRC" ]; then
    tar_args+=(-C / "${ATTACH_SRC#/}")   # "/attachments" → archived as attachments/
  else
    echo "[backup] warn: $ATTACH_SRC not mounted — archive has NO attachments" >&2
  fi

  echo "[backup] packing → $out"
  if tar czf "$tmp" "${tar_args[@]}"; then
    mv "$tmp" "$out"
    echo "[backup] ok: $(du -h "$out" | cut -f1)  →  $out"
  else
    echo "[backup] pack FAILED — keeping previous backups" >&2
    rm -f "$tmp"
  fi
  rm -rf "$work"

  # Prune old full backups.
  find "$DIR" -maxdepth 1 -name 'hris-full-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
  # Sweep any stale work dirs from a crashed run.
  find "$DIR" -maxdepth 1 -type d -name '.wip-*' -mtime +1 -exec rm -rf {} + 2>/dev/null
}

echo "[backup] starting — dir=$DIR keep=${KEEP_DAYS}d daily at ${HOUR}:00 (TZ=$(date '+%Z'))"

# One backup at startup so a freshly-deployed stack always has a recent restore point.
run_backup

# BACKUP_ONESHOT=1 → take a single backup and exit (manual "backup now" + self-tests).
if [ "${BACKUP_ONESHOT:-0}" = "1" ]; then
  echo "[backup] one-shot mode — done, exiting"
  exit 0
fi

while true; do
  now=$(date +%s)
  target=$(date -d "today ${HOUR}:00:00" +%s)
  if [ "$target" -le "$now" ]; then
    target=$(date -d "tomorrow ${HOUR}:00:00" +%s)
  fi
  echo "[backup] next run at $(date -d "@$target" '+%F %T %Z') (in $(( target - now ))s)"
  sleep "$(( target - now ))"
  run_backup
done
