#!/bin/bash
# JIRA Intern — host-side AI ENRICHER for PR Readiness Reports.
#
#   bash enrich-worker.sh          # foreground; Ctrl-C to stop
#   start-jira-board.sh installs it as a launchd login agent (com.jira-board.enricher), so it is
#   always running on the Mac and enriched reports need no terminal step.
#
# WHY. The board's server may live where the agent cannot run — the Docker container has no
# cursor-agent and no login. There, pr-report.sh writes the deterministic base and leaves a marker
# in reports/.enrich/<KEY>. This loop runs HERE, where cursor-agent is signed in, picks the markers
# up and runs that very same pr-report.sh, so Regenerate and the bulk runs in the board come out
# enriched at the AI level chosen in Settings. reports/ is shared with the container (bind mount),
# so the enriched file shows up in the board on its next poll.
#
# Heartbeat: reports/.enricher.alive is rewritten every few seconds; serve.mjs treats a heartbeat
# younger than 30s as "the enricher is alive" and keeps handed-off reports showing as generating.
set -o pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERN_DIR="$(cd "$HERE/.." && pwd)"
REPORTS_DIR="$INTERN_DIR/reports"
QUEUE="$REPORTS_DIR/.enrich"
ALIVE="$REPORTS_DIR/.enricher.alive"
LOCK="$REPORTS_DIR/.enricher.lock"
LOG_DIR="$INTERN_DIR/logs"; LOG="$LOG_DIR/enricher.log"
PY="$INTERN_DIR/pr_report.py"
mkdir -p "$QUEUE" "$LOG_DIR"
# shellcheck source=lock-util.sh
. "$HERE/lock-util.sh"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }

# One worker at a time — a second copy would run two agents against the same report.
lock_clear_stale "$LOCK"
if lock_is_held "$LOCK"; then
  log "another enricher holds $LOCK — exiting"; exit 3
fi
printf '%s %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK"

# Heartbeat in the background, so a long agent run never makes the worker look dead.
( while true; do printf '%s %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ALIVE"; sleep 5; done ) &
HEARTBEAT=$!
cleanup() { kill "$HEARTBEAT" 2>/dev/null; rm -f "$LOCK" "$ALIVE"; }
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

# Which binary is the agent? config.json may rename it (connector.bin) — same lookup as pr-report.sh.
AGENT_BIN=cursor-agent; AGENT_BIN_FALLBACKS="$HOME/.local/bin/cursor-agent"
command -v node >/dev/null 2>&1 && eval "$(node "$HERE/config.mjs" shellenv 2>/dev/null)"
have_agent() {
  command -v "$AGENT_BIN" >/dev/null 2>&1 && return 0
  local f; IFS=':' read -r -a FBS <<< "$AGENT_BIN_FALLBACKS"
  for f in "${FBS[@]}"; do [ -x "$f" ] && return 0; done
  return 1
}

# Self-heal: a previous worker killed mid-enrichment (a redeploy reloads this agent) can leave a
# report half-written next to its saved base. Restore any such report before doing new work.
for base in "$REPORTS_DIR"/.base-*.json; do
  [ -e "$base" ] || continue
  key="$(basename "$base" .json)"; key="${key#.base-}"
  if ! python3 "$PY" validate "$key" --base "$base" >/dev/null 2>&1; then
    cp "$base" "$REPORTS_DIR/$key.json" && log "restored $key from its saved base (previous enrichment was interrupted)"
  fi
  rm -f "$base" "$REPORTS_DIR/.ctx-$key.json"
done

log "enricher started (pid $$) — watching $QUEUE"
while true; do
  if ! have_agent; then
    log "$AGENT_BIN not found on this machine — hand-offs wait until it is installed and signed in"
    sleep 60; continue
  fi
  for marker in "$QUEUE"/*; do
    [ -e "$marker" ] || continue
    key="$(basename "$marker")"
    stamp="$(cat "$marker" 2>/dev/null)"
    rm -f "$marker"
    if ! [[ "$key" =~ ^[A-Z][A-Z0-9]+-[0-9]+$ ]]; then log "ignoring odd marker '$key'"; continue; fi
    log "enriching $key (handed off ${stamp:-earlier})"
    bash "$HERE/pr-report.sh" "$key" >>"$LOG" 2>&1
    log "$key finished (exit $?)"
  done
  sleep 4
done
