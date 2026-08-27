#!/bin/bash
# Weekly "Completed archive" agent — the SLOW job: fetches EVERY closed ticket I've ever owned, with real
# Bitbucket branches + all PRs, caches each, and MERGES them into data.json's completed[] (leaving the active
# tickets[] alone). Keep it SEPARATE from the daily run-intern.sh and schedule it weekly.
#   bash update-completed.sh             # incremental — reuses cache, only fetches new/stale tickets
#   FRESH=1 bash update-completed.sh     # wipe the cache and rebuild the whole archive from scratch
#   TIMEOUT_SEC=10800 bash update-completed.sh   # override the 2h ceiling
set -o pipefail

# Same headless env as run-intern.sh (PATH, shell profile, connector secrets/MCP tokens).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
[ -f "$HOME/.zprofile" ] && . "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.zshrc" ]    && . "$HOME/.zshrc"    2>/dev/null

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Portable config (single source of truth: ../config.json) — see run-intern.sh for the pattern.
AGENT_CONNECTOR=cursor; AGENT_BIN=cursor-agent; AGENT_BIN_FALLBACKS="$HOME/.local/bin/cursor-agent"
AGENT_PROMPT_FLAG='-p'; AGENT_EXTRA_ARGS='--output-format text --force'; AGENT_MODEL_FLAG='--model'
AGENT_SECRETS="$HOME/.cursor/mcp-secrets.env"; AGENT_INSTALL_HINT='curl https://cursor.com/install -fsS | bash'
MODEL_MAIN=auto; TIMEOUT_WEEKLY=7200
command -v node >/dev/null 2>&1 && eval "$(node "$HERE/config.mjs" shellenv 2>/dev/null)"
if [ -f "$AGENT_SECRETS" ]; then set -a; . "$AGENT_SECRETS"; set +a; fi
PROMPT_FILE="$HERE/../prompts/intern-completed-prompt.md"
GIT_ROOT="$(cd "$HERE/../../.." && pwd)"
INTERN_DIR="$(cd "$HERE/.." && pwd)"
LOG_DIR="$HERE/../logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/completed-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$INTERN_DIR/cache"

# Both this job and the daily run rewrite the SAME data.json. Refuse to start if the daily run
# (.intern.lock) or a single-ticket refresh (.refresh.lock) is in flight — otherwise this long job
# reads data.json, they finish, and our write-back reverts their fresh tickets[] (lost update).
for L in "$INTERN_DIR/.intern.lock" "$INTERN_DIR/.refresh.lock"; do
  if [ -f "$L" ]; then
    echo "$(date): $(basename "$L") held by another intern job — skipping this archive run" | tee -a "$LOG"
    exit 3
  fi
done

# Its own lock (so the board/served mode can tell the archive job is running, distinct from the daily run).
LOCK="$INTERN_DIR/.completed.lock"
echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

if [ -n "$FRESH" ]; then
  rm -f "$INTERN_DIR/cache/"*.json 2>/dev/null
  echo "$(date): FRESH=1 — cleared per-ticket cache; rebuilding the whole archive" | tee -a "$LOG"
fi

AGENT="$(command -v "$AGENT_BIN")"
if [ -z "$AGENT" ]; then
  IFS=':' read -r -a FBS <<< "$AGENT_BIN_FALLBACKS"
  for f in "${FBS[@]}"; do [ -x "$f" ] && AGENT="$f" && break; done
fi
[ -z "$AGENT" ] && { echo "$(date): $AGENT_BIN not found (connector: $AGENT_CONNECTOR). Install: $AGENT_INSTALL_HINT" | tee -a "$LOG"; exit 127; }

cd "$GIT_ROOT"
echo "$(date): completed-archive run via $AGENT (connector=$AGENT_CONNECTOR, cwd=$GIT_ROOT)" | tee -a "$LOG"
PROMPT_TEXT="$(node "$HERE/config.mjs" render "$PROMPT_FILE" 2>>"$LOG" || cat "$PROMPT_FILE")"
# NEVER launch with an unrendered prompt — no identity + no MCP read-only policy. Fail loud.
if printf '%s' "$PROMPT_TEXT" | grep -q '{{'; then
  echo "$(date): prompt render failed (node/config.mjs unavailable?) — refusing to run with unrendered prompt" | tee -a "$LOG"
  exit 6
fi
RUN=( "$AGENT" "$AGENT_PROMPT_FLAG" "$PROMPT_TEXT" $AGENT_EXTRA_ARGS )
EFFECTIVE_MODEL="${MODEL:-$MODEL_MAIN}"
[ -n "$EFFECTIVE_MODEL" ] && [ "$EFFECTIVE_MODEL" != "auto" ] && RUN+=( "$AGENT_MODEL_FLAG" "$EFFECTIVE_MODEL" )

# Longer ceiling than the daily run — this walks the whole history. Resumable, so a timeout is fine.
SECS="${TIMEOUT_SEC:-$TIMEOUT_WEEKLY}"
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout)"
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" "$SECS" "${RUN[@]}" >> "$LOG" 2>&1
else
  "${RUN[@]}" >> "$LOG" 2>&1
fi
code=$?
[ "$code" = "124" ] && echo "$(date): TIMED OUT after ${SECS}s — resumes next run (cache persists)" | tee -a "$LOG"

# Re-sync data.js from data.json (deterministic — never rely on the agent to write both). Atomic.
if [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  if node "$HERE/sync-datajs.mjs" "$INTERN_DIR" 2>>"$LOG"; then
    echo "$(date): re-synced data.js from data.json" | tee -a "$LOG"
  else
    echo "$(date): WARNING could not regenerate data.js (is data.json valid JSON?)" | tee -a "$LOG"
  fi
fi

# One-line result for a Mac Shortcut notification (must be the last stdout line).
case "$code" in
  0)   RESULT="✅ Completed archive updated" ;;
  124) RESULT="⏱️ Completed archive timed out (resumes next run)" ;;
  127) RESULT="⚠️ Completed archive: agent CLI not found" ;;
  *)   RESULT="❌ Completed archive failed (exit $code)" ;;
esac
if [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  COUNT="$(node -e 'try{const d=require(process.argv[1]+"/data.json");process.stdout.write(" — "+((d.completed||[]).length)+" completed tickets")}catch(e){}' "$INTERN_DIR" 2>/dev/null)"
  RESULT="$RESULT$COUNT"
fi
echo "$(date): $RESULT" >> "$LOG"
echo "$RESULT"
exit "$code"
