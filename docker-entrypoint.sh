#!/usr/bin/env bash
# Container entrypoint for My Jira Board.
#
# It brings the board up and keeps its data fresh on its own, so you never have to
# run the fetch by hand again:
#   1. seed an empty mounted volume from the image baseline (if needed)
#   2. load Jira/Bitbucket tokens (mounted secrets file and/or -e/--env-file)
#   3. fetch once on start                    (REFRESH_ON_START=1, default)
#   4. keep refreshing in the background      (REFRESH_INTERVAL seconds, default 900)
#   5. serve the board in the foreground      (the in-app Refresh button also works)
set -u

APP_DIR="${APP_DIR:-/app}"
INTERN_DIR="$APP_DIR/jira-intern"
SEED_DIR="/opt/jira-intern-seed"

log() { echo "[entrypoint] $*"; }

# 1) Seed. If a volume was mounted over jira-intern and it's empty, restore the baked
#    scripts + starter data so the board isn't blank and the fetch scripts exist.
if [ ! -f "$INTERN_DIR/daily_fetch.py" ]; then
  log "jira-intern is empty — seeding from the image baseline"
  mkdir -p "$INTERN_DIR"
  cp -a "$SEED_DIR/." "$INTERN_DIR/" 2>/dev/null || true
fi

# 2) Secrets. Env vars passed with -e/--env-file always win (load_env() in the Python
#    scripts uses setdefault); sourcing the mounted file just makes the token visible to
#    this script too, so the on-start/auto-refresh gates below work.
SECRETS="${AGENT_SECRETS:-$HOME/.cursor/mcp-secrets.env}"
if [ -f "$SECRETS" ]; then
  log "loading secrets from $SECRETS"
  set -a; . "$SECRETS"; set +a
fi

have_token() { [ -n "${JIRA_PERSONAL_TOKEN:-}" ]; }

# Use the lock-aware runner (not raw daily_fetch.py). Writing `.intern.lock` with `$$`
# from this script is unsafe: after `exec node`, `$$` is the Node server PID, so a
# leftover lock looks "live" forever and wedges Refresh / Rebuild archive.
run_fetch() {
  if ! have_token; then
    log "no JIRA_PERSONAL_TOKEN found — skipping fetch; board serves last saved data"
    return 0
  fi
  local runner="$INTERN_DIR/local-runner/run-intern.sh"
  log "refreshing active tickets…"
  if [ -f "$runner" ]; then
    bash "$runner"
    code=$?
  else
    python3 "$INTERN_DIR/daily_fetch.py"
    code=$?
  fi
  if [ "$code" = "0" ]; then
    log "refresh done"
  elif [ "$code" = "3" ]; then
    log "refresh skipped — another job holds the data lock"
  else
    log "refresh failed (exit $code) — keeping the previous data"
  fi
}

# 3) Fetch once on boot (backgrounded so a slow/offline Jira never blocks the server).
if [ "${REFRESH_ON_START:-1}" != "0" ]; then
  run_fetch &
fi

# 4) Periodic auto-refresh. REFRESH_INTERVAL=0 disables it.
INTERVAL="${REFRESH_INTERVAL:-900}"
if have_token && [ "$INTERVAL" -gt 0 ] 2>/dev/null; then
  log "auto-refresh every ${INTERVAL}s"
  ( while true; do sleep "$INTERVAL"; run_fetch; done ) &
else
  log "auto-refresh disabled (set REFRESH_INTERVAL and provide a token to enable)"
fi

# 5) Serve the board. exec => the server is the signal target under tini.
log "serving the board on ${BIND_HOST:-0.0.0.0}:${PORT:-4321}"
exec node "$APP_DIR/serve.mjs"
