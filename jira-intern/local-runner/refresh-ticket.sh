#!/bin/bash
# Targeted SINGLE-ticket refresh. Re-fetches ONE Jira ticket via cursor-agent and merges it into
# data.json (then re-syncs data.js). Invoked by serve.mjs  POST /api/refresh-ticket?key=<KEY>.
#   bash refresh-ticket.sh <KEY>
set -o pipefail
KEY="$1"
[ -z "$KEY" ] && { echo "usage: refresh-ticket.sh <KEY>"; exit 2; }

# Same headless env as run-intern.sh (PATH, shell profile, connector secrets/MCP tokens).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
[ -f "$HOME/.zprofile" ] && . "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.zshrc" ]    && . "$HOME/.zshrc"    2>/dev/null

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Portable config (single source of truth: ../config.json) — see run-intern.sh for the pattern.
AGENT_CONNECTOR=cursor; AGENT_BIN=cursor-agent; AGENT_BIN_FALLBACKS="$HOME/.local/bin/cursor-agent"
AGENT_PROMPT_FLAG='-p'; AGENT_EXTRA_ARGS='--output-format text --force'; AGENT_MODEL_FLAG='--model'
AGENT_SECRETS="$HOME/.cursor/mcp-secrets.env"; MODEL_MAIN=auto; TIMEOUT_REFRESH=600; REQUIRED_APPROVALS=2
command -v node >/dev/null 2>&1 && eval "$(node "$HERE/config.mjs" shellenv 2>/dev/null)"
if [ -f "$AGENT_SECRETS" ]; then set -a; . "$AGENT_SECRETS"; set +a; fi
GIT_ROOT="$(cd "$HERE/../../.." && pwd)"
INTERN_DIR="$(cd "$HERE/.." && pwd)"
LOG_DIR="$HERE/../logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/refresh-${KEY}-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$INTERN_DIR/cache"

# This rewrites the SHARED data.json. Refuse to run while a daily run (.intern.lock) or the weekly
# archive (.completed.lock) is mid-write, and take our own .refresh.lock so two refreshes don't
# clobber each other — otherwise concurrent writers cause lost updates on the canonical file.
for L in "$INTERN_DIR/.intern.lock" "$INTERN_DIR/.completed.lock" "$INTERN_DIR/.refresh.lock"; do
  if [ -f "$L" ]; then
    echo "$(date): another intern job holds $(basename "$L") — skipping refresh of $KEY" | tee -a "$LOG"
    exit 3
  fi
done
REFRESH_LOCK="$INTERN_DIR/.refresh.lock"
echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$REFRESH_LOCK"
trap 'rm -f "$REFRESH_LOCK"' EXIT INT TERM

AGENT="$(command -v "$AGENT_BIN")"
if [ -z "$AGENT" ]; then
  IFS=':' read -r -a FBS <<< "$AGENT_BIN_FALLBACKS"
  for f in "${FBS[@]}"; do [ -x "$f" ] && AGENT="$f" && break; done
fi
[ -z "$AGENT" ] && { echo "$(date): $AGENT_BIN not found (connector: $AGENT_CONNECTOR)" | tee -a "$LOG"; exit 127; }

# MCP allow/read-write policy comes from config.json (falls back to the classic read-only trio).
MCP_POLICY="$(node "$HERE/config.mjs" policy 2>/dev/null || echo 'Use ONLY the jira, confluence and bitbucket MCP servers, read-only.')"

PROMPT="You are refreshing ONE Jira ticket: $KEY. Never invent data.
$MCP_POLICY
Re-fetch the CURRENT state of $KEY and produce its FULL ticket object per the schema in $INTERN_DIR/prompts/intern-prompt.md
(mirrors git/jira-board/src/types.ts): key, title, status, column (todo|prog|rev|qa|done|hold), type, priority,
storyPoints, branch, pr {state(approved|comments|changes|declined|merged|none), id, url, approvals, openComments, merged, mergedAt,
sourceBranch, destinationBranch}, commentCount, ALL comments, lastUpdate, created, url, sprint, reporter, assignee, epic,
labels, components, description, acceptanceCriteria, related, confluence (with excerpts), externalLinks (with excerpts),
proposedSolution, openQuestions, sources, updateLog (lifecycle from the changelog: Opened + each status transition),
subtasks (full, nested) and subtaskCount.
Remember PR approval: a PR counts as approved only with >= $REQUIRED_APPROVALS approvals — report pr.approvals accurately.
STEPS:
 1) Write the full object to $INTERN_DIR/cache/$KEY.json.
 2) Update $INTERN_DIR/data.json: replace the entry whose key is \"$KEY\" inside tickets[] with this fresh object
    (add it if missing). If $KEY is now Done/Closed/Resolved, reflect that (and ensure parents appear in completed[]).
    Do NOT modify any OTHER ticket; keep the rest of data.json the same, only updating generatedAt to now.
Do NOT write data.js — the runner re-syncs it. If Jira is unavailable, leave data.json unchanged and stop."

cd "$GIT_ROOT"
# Snapshot for the deterministic aiSummary carry-forward (the fresh single-ticket fetch omits it).
PREV_DATA="$INTERN_DIR/.data.prev.$KEY.json"
[ -f "$INTERN_DIR/data.json" ] && cp "$INTERN_DIR/data.json" "$PREV_DATA" 2>/dev/null
echo "$(date): refreshing $KEY via $AGENT (connector=$AGENT_CONNECTOR)" | tee -a "$LOG"
RUN=( "$AGENT" "$AGENT_PROMPT_FLAG" "$PROMPT" $AGENT_EXTRA_ARGS )
EFFECTIVE_MODEL="${MODEL:-$MODEL_MAIN}"
[ -n "$EFFECTIVE_MODEL" ] && [ "$EFFECTIVE_MODEL" != "auto" ] && RUN+=( "$AGENT_MODEL_FLAG" "$EFFECTIVE_MODEL" )
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout)"
if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$TIMEOUT_REFRESH" "${RUN[@]}" >> "$LOG" 2>&1; else "${RUN[@]}" >> "$LOG" 2>&1; fi
code=$?

# Restore aiSummary onto the refreshed ticket (carry-forward, independent of the agent), then drop the snapshot.
if [ -f "$PREV_DATA" ] && [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  node "$HERE/carry-aisummary.mjs" "$PREV_DATA" "$INTERN_DIR/data.json" >>"$LOG" 2>&1 || true
fi
rm -f "$PREV_DATA"

# Deterministically re-sync data.js from data.json so the board picks up the change. Atomic.
if [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  node "$HERE/sync-datajs.mjs" "$INTERN_DIR" 2>>"$LOG" \
    && echo "$(date): re-synced data.js" | tee -a "$LOG"
fi
echo "$(date): refresh $KEY finished (exit $code) — log: $LOG" | tee -a "$LOG"
exit "$code"
