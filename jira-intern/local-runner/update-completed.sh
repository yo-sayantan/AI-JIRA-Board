#!/usr/bin/env bash
# Weekly "Completed archive" agent — the SLOW job: fetches EVERY closed ticket I've ever owned, with real
# Bitbucket branches + all PRs, caches each, and MERGES them into data.json's completed[] (leaving the active
# tickets[] alone). Keep it SEPARATE from the daily run-intern.sh and schedule it weekly.
#   bash update-completed.sh             # refresh every completed ticket ever assigned to me
#   FRESH=1 bash update-completed.sh     # also wipe the cache before rebuilding the whole archive
#   TIMEOUT_SEC=10800 bash update-completed.sh   # override the 2h ceiling
set -o pipefail

# shellcheck source=runner-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/runner-env.sh"
load_agent_secrets
# completed_archive.py reads these from its environment; shellenv only assigns them.
export COMPLETED_WORKERS COMPLETED_MAX_FETCH
PROMPT_FILE="$HERE/../prompts/intern-completed-prompt.md"
LOG="$LOG_DIR/completed-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$INTERN_DIR/cache"

# This long job reads data.json and writes it back; starting it while the daily run or a ticket
# refresh is mid-flight would revert their fresh tickets[] (lost update).
# Its own lock (so the board/served mode can tell the archive job is running, distinct from the daily run).
LOCK="$INTERN_DIR/.completed.lock"
refuse_if_locked "this archive run" "$LOCK" "$INTERN_DIR/.intern.lock" "$INTERN_DIR/.refresh.lock"
acquire_lock_or_exit "this archive run" "$LOCK"
# INT/TERM exit explicitly (130/143) so an interrupted fast path never falls through to the
# LLM fallback; the EXIT trap then removes the lock.
trap 'rm -f "$LOCK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "$FRESH" ]; then
  rm -f "$INTERN_DIR/cache/"*.json 2>/dev/null
  echo "$(date): FRESH=1 — cleared per-ticket cache; rebuilding the whole archive" | tee -a "$LOG"
fi

cd "$GIT_ROOT"
SECS="${TIMEOUT_SEC:-$TIMEOUT_WEEKLY}"

# ── FAST PATH ─────────────────────────────────────────────────────────────────
# completed_archive.py implements the same archive contract deterministically
# (per-ticket cache + merge completed[] only) in a fraction of the agent's time.
# The LLM agent below is the fallback. Debug the agent path with FORCE_AGENT=1.
FAST_OK=""
PARTIAL=""
if [ -z "$FORCE_AGENT" ] && command -v python3 >/dev/null 2>&1 && [ -f "$INTERN_DIR/completed_archive.py" ]; then
  echo "$(date): fast path — deterministic completed_archive.py (LLM agent is the fallback)…" | tee -a "$LOG"
  run_with_timeout "$SECS" python3 "$INTERN_DIR/completed_archive.py" >> "$LOG" 2>&1
  fast_code=$?
  if [ "$fast_code" = "0" ]; then
    FAST_OK=1
    code=0
    echo "$(date): fast path OK — skipping the agent run" | tee -a "$LOG"
  elif [ "$fast_code" = "4" ]; then
    # Partial: some tickets failed to rebuild but their previous rows were kept and the rest
    # were merged. Nothing for the agent to add — log it and finish normally.
    FAST_OK=1
    PARTIAL=1
    code=0
    echo "$(date): WARN fast path finished with failed tickets (see the JSON summary above) — previous rows kept, no agent fallback" | tee -a "$LOG"
  elif [ "$fast_code" = "2" ]; then
    # Configuration error (no Jira token). The agent would hit the same wall.
    FAST_OK=1
    code=2
    echo "$(date): fast path refused (exit 2: configuration — no Jira token?) — not falling back" | tee -a "$LOG"
  else
    echo "$(date): fast path failed (exit $fast_code) — falling back to the $AGENT_CONNECTOR agent" | tee -a "$LOG"
  fi
fi

if [ "$FAST_OK" != "1" ]; then
find_agent || { echo "$(date): $AGENT_BIN not found (connector: $AGENT_CONNECTOR). Install: $AGENT_INSTALL_HINT" | tee -a "$LOG"; exit 127; }

echo "$(date): completed-archive run via $AGENT (connector=$AGENT_CONNECTOR, cwd=$GIT_ROOT)" | tee -a "$LOG"
PROMPT_TEXT="$(node "$HERE/config.mjs" render "$PROMPT_FILE" 2>>"$LOG" || cat "$PROMPT_FILE")"
# NEVER launch with an unrendered prompt — no identity + no MCP read-only policy. Fail loud.
if printf '%s' "$PROMPT_TEXT" | grep -q '{{'; then
  echo "$(date): prompt render failed (node/config.mjs unavailable?) — refusing to run with unrendered prompt" | tee -a "$LOG"
  exit 6
fi
agent_command "$PROMPT_TEXT"
# Longer ceiling than the daily run — this walks the whole history. Resumable, so a timeout is fine.
run_with_timeout "$SECS" "${RUN[@]}" >> "$LOG" 2>&1
code=$?
[ "$code" = "124" ] && echo "$(date): TIMED OUT after ${SECS}s — resumes next run (cache persists)" | tee -a "$LOG"
fi

sync_datajs

# One-line result for a Mac Shortcut notification (must be the last stdout line).
case "$code" in
  0)   if [ "${PARTIAL:-}" = "1" ]; then RESULT="⚠️ Completed archive updated — some tickets kept their previous row (see log)"; else RESULT="✅ Completed archive updated"; fi ;;
  2)   RESULT="⚠️ Completed archive skipped: no Jira token configured" ;;
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
