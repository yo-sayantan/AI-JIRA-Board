#!/bin/bash
# JIRA Intern — Mac local runner via the Cursor CLI (cursor-agent).
# Uses the MODELS and MCP SERVERS you already have configured in Cursor (~/.cursor/mcp.json):
# jira, confluence, bitbucket, etc. Auth + tokens come from ~/.cursor/mcp-secrets.env at runtime —
# nothing is stored or read by this repo.
#
# Trigger from a Mac Shortcut ("Run Shell Script") or any scheduler:
#     bash /path/to/AI-JIRA-Board/jira-intern/local-runner/run-intern.sh
# Optional model override:  MODEL="auto" bash run-intern.sh
set -o pipefail

# Shortcuts/launchd start with a minimal environment — restore PATH and load your shell profile.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
[ -f "$HOME/.zprofile" ] && . "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.zshrc" ]    && . "$HOME/.zshrc"    2>/dev/null

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lock-util.sh
. "$HERE/lock-util.sh"

# ── Portable config (single source of truth: ../config.json) ────────────────
# Defaults below match the original cursor setup; config.mjs overrides them when present,
# so switching user / connector (cursor→codex→claude) / models / MCP policy is a config-only change.
AGENT_CONNECTOR=cursor; AGENT_BIN=cursor-agent; AGENT_BIN_FALLBACKS="$HOME/.local/bin/cursor-agent"
AGENT_PROMPT_FLAG='-p'; AGENT_EXTRA_ARGS='--output-format text --force'; AGENT_MODEL_FLAG='--model'
AGENT_SECRETS="$HOME/.cursor/mcp-secrets.env"; AGENT_API_KEY_ENV='CURSOR_API_KEY'
AGENT_INSTALL_HINT='curl https://cursor.com/install -fsS | bash'
MODEL_MAIN=auto; TIMEOUT_DAILY=1800
command -v node >/dev/null 2>&1 && eval "$(node "$HERE/config.mjs" shellenv 2>/dev/null)"

# Load the connector's secrets so headless auth works and MCP tokens are present.
# set -a exports everything to the agent child process.
if [ -f "$AGENT_SECRETS" ]; then set -a; . "$AGENT_SECRETS"; set +a; fi
PROMPT_FILE="$HERE/../prompts/intern-prompt.md"
GIT_ROOT="$(cd "$HERE/../../.." && pwd)"          # jira-board/jira-intern/local-runner -> git/
INTERN_DIR="$(cd "$HERE/.." && pwd)"              # jira-board/jira-intern
LOG_DIR="$HERE/../logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
# NOTE: this DAILY run handles ACTIVE tickets only and preserves the existing completed[]. The per-ticket
# cache + the historical archive are owned by the separate weekly job local-runner/update-completed.sh
# (run `FRESH=1 bash update-completed.sh` to rebuild the archive).

# Don't run concurrently with the weekly archive or a single-ticket refresh — all three write the
# same data.json, and overlapping writes cause lost updates / torn files.
# Stale locks (dead PID / leftover from a Docker recreate) are cleared, not treated as held.
for L in "$INTERN_DIR/.completed.lock" "$INTERN_DIR/.refresh.lock"; do
  lock_clear_stale "$L"
  if lock_is_held "$L"; then
    echo "$(date): $(basename "$L") held by another intern job — skipping this daily run" | tee -a "$LOG"
    exit 3
  fi
done

# Run-lock so the board (served mode) can tell whether the intern is running, even across page
# refreshes and regardless of who launched it (button or terminal). Removed on any exit.
LOCK="$INTERN_DIR/.intern.lock"
echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

# The agent CLI is located LATER — only inside the fallback, if the fast path fails. The
# deterministic daily_fetch.py is the PRIMARY path and needs no agent, so a machine without
# cursor-agent (e.g. the Docker image) must still run the fast path instead of exiting here.
cd "$GIT_ROOT"   # run from git/ so the agent (fallback) can read your repos AND the MCP config
echo "$(date): starting jira-intern daily run (connector=$AGENT_CONNECTOR, cwd=$GIT_ROOT)" | tee -a "$LOG"

# Snapshot data.json so we can deterministically carry `aiSummary` forward after the rewrite
# (the agent re-fetches tickets and may drop it; this restores it by key regardless).
PREV_DATA="$INTERN_DIR/.data.prev.json"
[ -f "$INTERN_DIR/data.json" ] && cp "$INTERN_DIR/data.json" "$PREV_DATA" 2>/dev/null

TIMEOUT_BIN="$(command -v timeout || command -v gtimeout)"

# ── FAST PATH ─────────────────────────────────────────────────────────────────
# The deterministic fetch (daily_fetch.py) implements the same contract as the LLM
# agent but finishes in seconds instead of minutes. It is the PRIMARY path; the
# agent below is the fallback for when the script fails (auth, Jira quirks, drift).
# Debug the agent path with FORCE_AGENT=1.
FAST_OK=""
if [ -z "$FORCE_AGENT" ] && command -v python3 >/dev/null 2>&1 && [ -f "$INTERN_DIR/daily_fetch.py" ]; then
  echo "$(date): fast path — deterministic daily_fetch.py (LLM agent is the fallback)…" | tee -a "$LOG"
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" 300 python3 "$INTERN_DIR/daily_fetch.py" >> "$LOG" 2>&1
  else
    python3 "$INTERN_DIR/daily_fetch.py" >> "$LOG" 2>&1
  fi
  fast_code=$?
  if [ "$fast_code" = "0" ]; then
    FAST_OK=1
    code=0
    echo "$(date): fast path OK — skipping the agent run" | tee -a "$LOG"
  else
    echo "$(date): fast path failed (exit $fast_code) — falling back to the $AGENT_CONNECTOR agent" | tee -a "$LOG"
  fi
fi

if [ "$FAST_OK" != "1" ]; then
# The fast path failed — NOW we need the LLM agent. Locate it (config: connector.<name>.bin /
# binFallbacks). If it isn't installed there's nothing more we can do, so fail with 127.
AGENT="$(command -v "$AGENT_BIN")"
if [ -z "$AGENT" ]; then
  IFS=':' read -r -a FBS <<< "$AGENT_BIN_FALLBACKS"
  for f in "${FBS[@]}"; do [ -x "$f" ] && AGENT="$f" && break; done
fi
if [ -z "$AGENT" ]; then
  echo "$(date): fast path failed and $AGENT_BIN not found (connector: $AGENT_CONNECTOR). Install:  $AGENT_INSTALL_HINT" | tee -a "$LOG"
  exit 127
fi
if [ -n "$AGENT_API_KEY_ENV" ] && [ -z "${!AGENT_API_KEY_ENV}" ]; then
  echo "$(date): WARNING: $AGENT_API_KEY_ENV is empty after sourcing $AGENT_SECRETS." | tee -a "$LOG"
  echo "$(date):   -> add a valid  $AGENT_API_KEY_ENV=<key>  line to that file, or log the $AGENT_CONNECTOR CLI in once." | tee -a "$LOG"
fi
echo "$(date): falling back to $AGENT (connector=$AGENT_CONNECTOR)" | tee -a "$LOG"
# Render the prompt: {{TOKENS}} (user id, endpoints, MCP allow/read-write policy) come from config.json.
PROMPT_TEXT="$(node "$HERE/config.mjs" render "$PROMPT_FILE" 2>>"$LOG" || cat "$PROMPT_FILE")"
# NEVER launch with an unrendered prompt (node/config.mjs unavailable): the agent would run for
# up to 30m with no identity and — worse — no MCP read-only policy. Fail loud instead.
if printf '%s' "$PROMPT_TEXT" | grep -q '{{'; then
  echo "$(date): prompt render failed (node/config.mjs unavailable?) — refusing to run with unrendered prompt" | tee -a "$LOG"
  rm -f "$PREV_DATA"
  exit 6
fi

# Extra args come from the connector config (word-split deliberately; args must not contain spaces).
# MODEL env > config models.main; "auto" means let the connector pick (flag omitted).
RUN=( "$AGENT" "$AGENT_PROMPT_FLAG" "$PROMPT_TEXT" $AGENT_EXTRA_ARGS )
EFFECTIVE_MODEL="${MODEL:-$MODEL_MAIN}"
[ -n "$EFFECTIVE_MODEL" ] && [ "$EFFECTIVE_MODEL" != "auto" ] && RUN+=( "$AGENT_MODEL_FLAG" "$EFFECTIVE_MODEL" )

if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" "$TIMEOUT_DAILY" "${RUN[@]}" >> "$LOG" 2>&1
else
  "${RUN[@]}" >> "$LOG" 2>&1
fi
code=$?
[ "$code" = "124" ] && echo "$(date): TIMED OUT after ${TIMEOUT_DAILY}s (headless agent runs can hang)" | tee -a "$LOG"
fi

# Crash-safety: a timed-out/killed agent can leave data.json truncated or invalid. If it no longer
# parses, restore the pre-run snapshot (the only known-good copy) BEFORE we touch data.js — otherwise
# a bad run permanently corrupts the canonical file. Mirrors summarize-active.sh.
if [ -f "$PREV_DATA" ] && command -v node >/dev/null 2>&1; then
  if [ ! -f "$INTERN_DIR/data.json" ] || ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$INTERN_DIR/data.json" 2>/dev/null; then
    echo "$(date): data.json missing/invalid after run — restoring pre-run snapshot" | tee -a "$LOG"
    cp "$PREV_DATA" "$INTERN_DIR/data.json"
  fi
fi

# Deterministically carry aiSummary forward from the pre-run snapshot (independent of the agent),
# then drop the snapshot. Runs regardless of exit code so summaries survive a failed/timed-out run.
if [ -f "$PREV_DATA" ] && [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  node "$HERE/carry-aisummary.mjs" "$PREV_DATA" "$INTERN_DIR/data.json" >>"$LOG" 2>&1 || true
fi
rm -f "$PREV_DATA"

# Log rotation — keep the most recent 40 run logs so logs/ doesn't grow forever.
ls -1t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +41 | xargs rm -f 2>/dev/null || true

# Keep data.js perfectly in sync with data.json (deterministic — never rely on the agent to write both).
# The jira-board app loads data.js (window.__JIRA_DATA__) on file://; this guarantees it matches data.json.
# Atomic write via the shared helper so the board never loads a torn data.js.
if [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  if node "$HERE/sync-datajs.mjs" "$INTERN_DIR" 2>>"$LOG"; then
    echo "$(date): regenerated data.js from data.json" | tee -a "$LOG"
  else
    echo "$(date): WARNING could not regenerate data.js (is data.json valid JSON?)" | tee -a "$LOG"
  fi
fi

# PR Readiness Reports (best-effort, BACKGROUND): for every ticket whose PR appeared or changed since
# its last report, (re)generate jira-intern/reports/<KEY>.json. Detached with nohup so a slow agent
# never delays this run; the board shows "report in progress" from reports/.status.json meanwhile.
# Off with config.json → reports.autoGenerate=false (REPORTS_AUTO=0). Capped by reports.maxPerRun.
if [ "$code" = "0" ] && [ "${REPORTS_AUTO:-1}" != "0" ] && [ -f "$HERE/pr-reports-backfill.sh" ]; then
  echo "$(date): launching PR readiness report pass in the background…" | tee -a "$LOG"
  nohup bash "$HERE/pr-reports-backfill.sh" --auto >>"$LOG_DIR/reports-auto.log" 2>&1 &
fi

# AI-summary pass (cheap, LOCAL-only): add a short aiSummary to each active ticket. Best-effort —
# never fails the main run. Skip with SKIP_SUMMARY=1; pick a cheap model with SUMMARY_MODEL=…
# The summary pass boots the agent CLI (~minutes) even when there's nothing to do —
# check first whether any active ticket is missing/outdated on aiSummary (the same
# skip-if-current rule the summary prompt applies: aiSummaryAt >= lastUpdate = current).
NEED_SUMMARY=1
if command -v python3 >/dev/null 2>&1 && [ -f "$INTERN_DIR/data.json" ]; then
  NEED_SUMMARY="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    stale = sum(1 for t in d.get("tickets", []) if (t.get("aiSummaryAt") or "") < (t.get("lastUpdate") or ""))
    print(1 if stale else 0)
except Exception:
    print(1)
' "$INTERN_DIR/data.json" 2>/dev/null || echo 1)"
fi
if [ "$code" = "0" ] && [ -z "$SKIP_SUMMARY" ] && [ "$NEED_SUMMARY" = "1" ] && [ -f "$HERE/summarize-active.sh" ]; then
  echo "$(date): running AI-summary pass…" | tee -a "$LOG"
  bash "$HERE/summarize-active.sh" >> "$LOG" 2>&1 || echo "$(date): summary pass non-zero exit (ignored)" | tee -a "$LOG"
elif [ "$code" = "0" ] && [ "$NEED_SUMMARY" = "0" ]; then
  echo "$(date): AI summaries all current — skipping the summary pass" | tee -a "$LOG"
fi

echo "$(date): finished (exit $code) — log: $LOG" >> "$LOG"

# --- Final one-line result for Mac Shortcuts ---------------------------------
# `run-intern.sh | tail -n 1` feeds this single line into the Shortcut
# notification, so it MUST be the last thing written to stdout.
case "$code" in
  0)   RESULT="✅ JIRA Intern done" ;;
  124) RESULT="⏱️ JIRA Intern timed out ($((TIMEOUT_DAILY / 60))m)" ;;
  127) RESULT="⚠️ JIRA Intern: agent CLI not found" ;;
  *)   RESULT="❌ JIRA Intern failed (exit $code)" ;;
esac

# Append brief counts when data.json is available (best-effort, never fails the run).
if [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  COUNTS="$(node -e 'try{const d=require(process.argv[1]+"/data.json");const t=Array.isArray(d.tickets)?d.tickets.length:0;const c=Array.isArray(d.completed)?d.completed.length:0;process.stdout.write(" — "+t+" tickets, "+c+" completed")}catch(e){}' "$INTERN_DIR" 2>/dev/null)"
  RESULT="$RESULT$COUNTS"
fi

echo "$(date): $RESULT" >> "$LOG"   # keep the summary in the log too
echo "$RESULT"                       # <-- LAST stdout line == Shortcut notification
exit "$code"
