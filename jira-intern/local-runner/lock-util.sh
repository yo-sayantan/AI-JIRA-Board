#!/usr/bin/env bash
# Shared lock helpers for the jira-intern runners. Mirrors server/locks.mjs rule for rule,
# so the shell runners and the board server never disagree about a lock.
#
# Lock files hold ONE line: "<pid> <ISO-timestamp> <hostname>". The hostname is the
# machine (or container — Docker's hostname is the container id) that wrote the lock.
# Readers that only look at the first two fields (older server builds) or at the mtime
# (ai-intern/worker.py) keep working.
#
# Three rules decide whether a lock is HELD; otherwise it is STALE and may be removed:
#   1. dead PID (same host)           → stale
#   2. no usable PID (missing, ≤ 1)   → stale once older than LOCK_MAX_AGE_SEC (45 min)
#   3. live PID (same host)           → held, until the hard ceiling LOCK_HARD_MAX_AGE_SEC
#                                       (8 h) — after that the PID was recycled: stale
#   A lock written on ANOTHER host (Mac vs container, or a previous container) is judged
#   by rule 2 only: its PID means nothing in this PID namespace.
#
# Acquisition is atomic: lock_acquire creates the file with noclobber (O_EXCL), so two
# runners that both saw "free" cannot both win; it retries once after clearing a stale
# lock. Callers exit 3 when it fails — the board maps exit 3 to "another refresh/archive
# was already running".
#
# Usage (from any local-runner/*.sh):
#   # shellcheck source=lock-util.sh
#   . "$HERE/lock-util.sh"
#   if lock_is_held "$INTERN_DIR/.intern.lock"; then ...; fi
#   lock_clear_stale "$INTERN_DIR/.intern.lock"
#   lock_acquire "$INTERN_DIR/.intern.lock" || exit 3

LOCK_MAX_AGE_SEC="${LOCK_MAX_AGE_SEC:-2700}"            # 45 min — PID-less / other-host locks
LOCK_HARD_MAX_AGE_SEC="${LOCK_HARD_MAX_AGE_SEC:-28800}" # 8 h — even a live PID is stale after this

# This machine's name as written into locks. bash sets HOSTNAME itself; the fallbacks
# cover shells that clear it (slim images may not ship the hostname binary).
lock_hostname() {
  local h="${HOSTNAME:-}"
  [ -n "$h" ] || h="$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo unknown)"
  printf '%s' "$h"
}

# Age in seconds of an ISO-8601 UTC timestamp; a huge number when it cannot be parsed
# (so an unreadable lock counts as stale, never as held forever).
lock_age_sec() {
  local started="$1" then now
  [ -n "$started" ] || { echo 999999; return; }
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
from datetime import datetime, timezone
import sys
try:
    t = datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
    print(int((datetime.now(timezone.utc) - t).total_seconds()))
except Exception:
    print(999999)
" "$started" 2>/dev/null && return
  fi
  # No python: GNU date, then BSD date.
  then="$(date -u -d "$started" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$started" +%s 2>/dev/null)" \
    || { echo 999999; return; }
  now="$(date -u +%s)"
  echo $(( now - then ))
}

# Return 0 if the lock is held by a LIVE run, 1 if free / stale / missing.
lock_is_held() {
  local path="$1" raw pid started host age
  [ -f "$path" ] || return 1
  raw="$(tr -d '\r' < "$path" 2>/dev/null | head -1)"
  read -r pid started host _ <<< "$raw"
  age="$(lock_age_sec "$started")"

  # Another host or a previous container: the PID is meaningless here — rule 2 only.
  if [ -n "$host" ] && [ "$host" != "$(lock_hostname)" ]; then
    [ "$age" -lt "$LOCK_MAX_AGE_SEC" ] 2>/dev/null
    return
  fi

  if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ]; then
    if kill -0 "$pid" 2>/dev/null; then
      # Rule 3: live — unless the lock outlived the hard ceiling (recycled PID).
      [ "$age" -lt "$LOCK_HARD_MAX_AGE_SEC" ] 2>/dev/null
      return
    fi
    return 1 # Rule 1: dead PID → stale
  fi

  # Rule 2: no usable PID — age decides.
  [ "$age" -lt "$LOCK_MAX_AGE_SEC" ] 2>/dev/null
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

# Atomically create the lock for THIS process ($$ = the sourcing script). Returns 1 when a
# live run holds it. noclobber is scoped to the subshell so the caller's redirections are
# unaffected.
lock_acquire() {
  local path="$1" attempt
  for attempt in 1 2; do
    lock_clear_stale "$path"
    if ( set -o noclobber; echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ) $(lock_hostname)" > "$path" ) 2>/dev/null; then
      return 0
    fi
    # Lost the race or the lock just went stale — one more pass after cleanup.
  done
  return 1
}
