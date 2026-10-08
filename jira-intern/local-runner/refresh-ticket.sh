#!/usr/bin/env bash
# Targeted SINGLE-ticket refresh. Re-fetches ONE Jira ticket and merges it into
# data.json (then re-syncs data.js). Invoked by serve.mjs  POST /api/refresh-ticket?key=<KEY>.
#   bash refresh-ticket.sh <KEY>
#
# PRIMARY path: deterministic daily_fetch.py --key (works in Docker; no agent CLI).
# FALLBACK: cursor-agent prompt (local Mac with the Cursor CLI installed).
set -o pipefail
KEY="${1:-}"
# The key lands in a log file name, a snapshot file name and (fallback path) an agent prompt,
# so accept only a well-formed Jira key such as ABC-123.
if ! [[ "$KEY" =~ ^[A-Za-z][A-Za-z0-9]+-[0-9]+$ ]]; then
  echo "usage: refresh-ticket.sh <TICKET-KEY>   (e.g. ABC-123)" >&2; exit 2
fi

# shellcheck source=runner-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/runner-env.sh"
load_agent_secrets
LOG="$LOG_DIR/refresh-${KEY}-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$INTERN_DIR/cache"

# This rewrites the SHARED data.json, and our own .refresh.lock keeps two refreshes apart.
REFRESH_LOCK="$INTERN_DIR/.refresh.lock"
refuse_if_locked "refresh of $KEY" "$REFRESH_LOCK" "$INTERN_DIR/.intern.lock" "$INTERN_DIR/.completed.lock"
acquire_lock_or_exit "refresh of $KEY" "$REFRESH_LOCK"
# INT/TERM exit explicitly (130/143) so an interrupted fast path never falls through to the
# LLM fallback; the EXIT trap then removes the lock.
trap 'rm -f "$REFRESH_LOCK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$GIT_ROOT"
# Snapshot for the deterministic aiSummary carry-forward (the fresh single-ticket fetch omits it
# only on the agent path; the Python path carries it itself — snapshot still harmless).
PREV_DATA="$INTERN_DIR/.data.prev.$KEY.json"
[ -f "$INTERN_DIR/data.json" ] && cp "$INTERN_DIR/data.json" "$PREV_DATA" 2>/dev/null

code=1
FAST_OK=""

# ── FAST PATH ─────────────────────────────────────────────────────────────────
# daily_fetch.py --key is the PRIMARY path (same contract as the daily board refresh).
# Debug the agent path with FORCE_AGENT=1.
if [ -z "$FORCE_AGENT" ] && command -v python3 >/dev/null 2>&1 && [ -f "$INTERN_DIR/daily_fetch.py" ]; then
  echo "$(date): fast path — daily_fetch.py --key $KEY (LLM agent is the fallback)…" | tee -a "$LOG"
  run_with_timeout 300 python3 "$INTERN_DIR/daily_fetch.py" --key "$KEY" >> "$LOG" 2>&1
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
# The agent CLI is located ONLY inside the fallback — Docker has no cursor-agent and must
# succeed on the Python path above instead of exiting 127 here.
if ! find_agent; then
  echo "$(date): fast path failed and $AGENT_BIN not found (connector: $AGENT_CONNECTOR)" | tee -a "$LOG"
  rm -f "$PREV_DATA"
  exit 127
fi

# MCP allow/read-write policy comes from config.json (falls back to the classic read-only trio).
MCP_POLICY="$(node "$HERE/config.mjs" policy 2>/dev/null || echo 'Use ONLY the jira, confluence and bitbucket MCP servers, read-only.')"

PROMPT="You are refreshing ONE Jira ticket: $KEY. Never invent data.
$MCP_POLICY
Re-fetch the CURRENT state of $KEY and produce its FULL ticket object per the schema in $INTERN_DIR/prompts/intern-prompt.md
(mirrors git/jira-board/src/types.ts): key, title, status, column (todo|blocked|prog|rev|qa|done|hold), type, priority,
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

echo "$(date): refreshing $KEY via $AGENT (connector=$AGENT_CONNECTOR)" | tee -a "$LOG"
agent_command "$PROMPT"
run_with_timeout "$TIMEOUT_REFRESH" "${RUN[@]}" >> "$LOG" 2>&1
code=$?

# Restore aiSummary onto the refreshed ticket (carry-forward, independent of the agent).
if [ -f "$PREV_DATA" ] && [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  node "$HERE/carry-aisummary.mjs" "$PREV_DATA" "$INTERN_DIR/data.json" >>"$LOG" 2>&1 || true
fi
fi

rm -f "$PREV_DATA"

# Python write_outputs already wrote data.js; this is the safety net for the agent path.
sync_datajs

# The refresh may have surfaced a new or changed PR — (re)generate this ticket's PR Readiness Report
# in the background if its fingerprint moved. Never delays or fails the refresh.
if [ "${REPORTS_AUTO:-1}" != "0" ] && [ -f "$HERE/pr-report.sh" ]; then
  nohup bash "$HERE/pr-report.sh" "$KEY" --if-needed >>"$LOG_DIR/reports-auto.log" 2>&1 &
fi

echo "$(date): refresh $KEY finished (exit $code) — log: $LOG" | tee -a "$LOG"
exit "$code"
