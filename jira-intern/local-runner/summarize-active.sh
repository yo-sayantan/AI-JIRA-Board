#!/bin/bash
# JIRA Intern — AI SUMMARY pass. Two tiers (see ../intern-summary-prompt.md):
#   • DEEP BRIEF for To Do / In-Progress tickets — enriched from linked Confluence docs, related
#     tickets, Bitbucket PRs/diffs, attachments and external links (read-only MCP), regenerated
#     when the ticket's lastUpdate outruns its aiSummaryAt.
#   • QUICK SUMMARY for In-Review / QA tickets + active sub-tasks — local-only, 2–4 sentences.
#
#   bash /Users/c22014e/git/jira-board/jira-intern/local-runner/summarize-active.sh
#
# COST: bounded by hard caps in the prompt (≤3 docs, ≤4 related, ≤2 PRs, ≤2 links per ticket;
# ≤6 deep briefs per run; skip-if-current). Route through a cheaper model with SUMMARY_MODEL=…
# (or config.json → models.summary). Examples:
#   SUMMARY_MODEL=haiku-4.5      bash summarize-active.sh
#   SUMMARY_MODEL=gpt-4o-mini    bash summarize-active.sh
set -o pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
[ -f "$HOME/.zprofile" ] && . "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.zshrc" ]    && . "$HOME/.zshrc"    2>/dev/null

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$HERE/../intern-summary-prompt.md"
GIT_ROOT="$(cd "$HERE/../../.." && pwd)"
INTERN_DIR="$(cd "$HERE/.." && pwd)"
LOG_DIR="$HERE/../logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/summary-$(date +%Y%m%d-%H%M%S).log"

# Portable config (single source of truth: ../config.json) — see run-intern.sh for the pattern.
AGENT_CONNECTOR=cursor; AGENT_BIN=cursor-agent; AGENT_BIN_FALLBACKS="$HOME/.local/bin/cursor-agent"
AGENT_PROMPT_FLAG='-p'; AGENT_EXTRA_ARGS='--output-format text --force'; AGENT_MODEL_FLAG='--model'
AGENT_SECRETS="$HOME/.cursor/mcp-secrets.env"; MODEL_SUMMARY=auto; TIMEOUT_SUMMARY=600
command -v node >/dev/null 2>&1 && eval "$(node "$HERE/config.mjs" shellenv 2>/dev/null)"
if [ -f "$AGENT_SECRETS" ]; then set -a; . "$AGENT_SECRETS"; set +a; fi
SUMMARY_MODEL="${SUMMARY_MODEL:-$MODEL_SUMMARY}"

# Nothing to summarize if there's no data yet.
if [ ! -f "$INTERN_DIR/data.json" ]; then
  echo "$(date): no data.json — run the main intern first." | tee -a "$LOG"; exit 0
fi

AGENT="$(command -v "$AGENT_BIN")"
if [ -z "$AGENT" ]; then
  IFS=':' read -r -a FBS <<< "$AGENT_BIN_FALLBACKS"
  for f in "${FBS[@]}"; do [ -x "$f" ] && AGENT="$f" && break; done
fi
if [ -z "$AGENT" ]; then
  echo "$(date): $AGENT_BIN not found (connector: $AGENT_CONNECTOR) — skipping AI summaries." | tee -a "$LOG"; exit 127
fi

cd "$GIT_ROOT"

# Refuse to run while the weekly archive or a single-ticket refresh is mid-write — all of them
# rewrite the same data.json (lost-update hazard). Same guard as the other writers.
for L in "$INTERN_DIR/.completed.lock" "$INTERN_DIR/.refresh.lock"; do
  if [ -f "$L" ]; then
    echo "$(date): $(basename "$L") held by another intern job — skipping summary pass" | tee -a "$LOG"
    exit 3
  fi
done

# Take the run-lock if it isn't already held, so the board shows "running" and other writers don't
# interleave. When chained from run-intern.sh the parent already holds it — leave it to the parent.
LOCK="$INTERN_DIR/.intern.lock"; OWN_LOCK=0
if [ ! -f "$LOCK" ]; then echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK"; OWN_LOCK=1; trap '[ "$OWN_LOCK" = 1 ] && rm -f "$LOCK"' EXIT INT TERM; fi

# Snapshot so a mid-write timeout can't leave data.json truncated/corrupted.
SNAP="$INTERN_DIR/.data.summary-snap.json"
cp "$INTERN_DIR/data.json" "$SNAP" 2>/dev/null

echo "$(date): starting AI-summary pass via $AGENT (connector=$AGENT_CONNECTOR, model=$SUMMARY_MODEL)" | tee -a "$LOG"

PROMPT_TEXT="$(node "$HERE/config.mjs" render "$PROMPT_FILE" 2>>"$LOG" || cat "$PROMPT_FILE")"
RUN=( "$AGENT" "$AGENT_PROMPT_FLAG" "$PROMPT_TEXT" $AGENT_EXTRA_ARGS )
[ -n "$SUMMARY_MODEL" ] && [ "$SUMMARY_MODEL" != "auto" ] && RUN+=( "$AGENT_MODEL_FLAG" "$SUMMARY_MODEL" )

TIMEOUT_BIN="$(command -v timeout || command -v gtimeout)"
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" "$TIMEOUT_SUMMARY" "${RUN[@]}" >> "$LOG" 2>&1
else
  "${RUN[@]}" >> "$LOG" 2>&1
fi
code=$?
[ "$code" = "124" ] && echo "$(date): summary pass TIMED OUT after ${TIMEOUT_SUMMARY}s" | tee -a "$LOG"

# Crash-safety: if data.json no longer parses (e.g. killed mid-write), restore the snapshot.
if command -v node >/dev/null 2>&1; then
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]+"/data.json","utf8"))' "$INTERN_DIR" 2>/dev/null; then
    echo "$(date): data.json invalid after summary pass — restoring snapshot" | tee -a "$LOG"
    [ -f "$SNAP" ] && cp "$SNAP" "$INTERN_DIR/data.json"
  fi
fi
rm -f "$SNAP"

# Keep data.js in sync with data.json (deterministic — never rely on the agent to write both). Atomic.
if command -v node >/dev/null 2>&1; then
  node "$HERE/sync-datajs.mjs" "$INTERN_DIR" 2>>"$LOG" \
    && echo "$(date): regenerated data.js after summaries" | tee -a "$LOG" \
    || echo "$(date): WARNING could not regenerate data.js" | tee -a "$LOG"
fi

echo "$(date): AI-summary pass finished (exit $code) — log: $LOG" | tee -a "$LOG"
exit "$code"
