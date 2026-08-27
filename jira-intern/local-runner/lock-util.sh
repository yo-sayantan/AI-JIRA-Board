#!/usr/bin/env bash
# Shared lock helpers for the jira-intern runners.
#
# Lock files are "<pid> <ISO-timestamp>". A lock is STALE (and may be removed) when:
#   • its PID is dead in THIS process namespace, or
#   • its timestamp is older than LOCK_MAX_AGE_SEC (default 45 minutes).
# This matches serve.mjs — without it, a Docker recreate leaves a lock whose PID
# belonged to the previous container, and every subsequent archive/daily run skips
# with exit 3 ("held by another intern job") even though nothing is running.
#
# Usage (from any local-runner/*.sh):
#   # shellcheck source=lock-util.sh
#   . "$HERE/lock-util.sh"
#   if lock_is_held "$INTERN_DIR/.intern.lock"; then ...; fi
#   lock_clear_stale "$INTERN_DIR/.intern.lock"

LOCK_MAX_AGE_SEC="${LOCK_MAX_AGE_SEC:-2700}" # 45 minutes — same ceiling as serve.mjs

# Return 0 if the lock is held by a LIVE run, 1 if free / stale / missing.
lock_is_held() {
  local path="$1" raw pid started age
  [ -f "$path" ] || return 1
  raw="$(tr -d '\r' < "$path" 2>/dev/null | head -1)"
  pid="$(printf '%s' "$raw" | awk '{print $1}')"
  started="$(printf '%s' "$raw" | awk '{print $2}')"

  if printf '%s' "$pid" | grep -Eq '^[1-9][0-9]*$'; then
    if kill -0 "$pid" 2>/dev/null; then
      # Live PID — still held (even if the timestamp is old; a long archive can run >45m).
      return 0
    fi
    # Dead PID → stale.
    return 1
  fi

  # No usable PID — fall back to age.
  if [ -n "$started" ]; then
    # BSD date (macOS) and GNU date both accept -u -d / -j -f with care; use python for portability.
    age="$(python3 -c "
from datetime import datetime, timezone
import sys
try:
    t = datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
    print(int((datetime.now(timezone.utc) - t).total_seconds()))
except Exception:
    print(999999)
" "$started" 2>/dev/null || echo 999999)"
    if [ "$age" -lt "$LOCK_MAX_AGE_SEC" ] 2>/dev/null; then
      return 0 # recent lock without a live PID still treated as held (paranoid)
    fi
  fi
  return 1
}

# If the lock is stale, remove it. Always returns 0.
lock_clear_stale() {
  local path="$1"
  [ -f "$path" ] || return 0
  if lock_is_held "$path"; then
    return 0
  fi
  rm -f "$path" 2>/dev/null || true
}
