#!/usr/bin/env bash
# Host watchdog (Story 2.7 / A.4) — run from cron every ~5 minutes:
#   */5 * * * * /path/to/app/scripts/watchdog.sh >> /var/log/hris-watchdog.log 2>&1
#
# Polls the API health endpoints. On failure it alerts through a FALLBACK channel
# that does NOT depend on the project SMTP (which may be the thing that's down):
# a webhook if WATCHDOG_WEBHOOK is set, otherwise a logged line + non-zero exit.
# This patches the paradox "if the worker is dead, who emails that the worker is dead".
set -u

API="${WATCHDOG_API:-http://localhost:3000}"
WEBHOOK="${WATCHDOG_WEBHOOK:-}"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

alert() {
  local msg="$1"
  echo "$(ts) ALERT: $msg"
  if [ -n "$WEBHOOK" ]; then
    curl -fsS -X POST "$WEBHOOK" -H 'Content-Type: application/json' \
      -d "{\"text\":\"[HRIS watchdog] $msg\"}" >/dev/null 2>&1 || true
  fi
}

check() {
  local path="$1"
  local code
  code=$(curl -fsS -o /dev/null -w '%{http_code}' "$API$path" 2>/dev/null || echo 000)
  if [ "$code" != "200" ]; then
    alert "$path returned $code"
    return 1
  fi
  return 0
}

rc=0
check /healthz || rc=1
check /readyz || rc=1

if [ "$rc" -eq 0 ]; then
  echo "$(ts) OK: healthz + readyz green"
fi
exit "$rc"
