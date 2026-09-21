#!/bin/bash
# JIRA Intern — PR READINESS REPORT for ONE ticket.
#
#   bash pr-report.sh <KEY> [--if-needed] [--no-ai]
#
# Two passes, so a report ALWAYS exists once a ticket has a pull request:
#   1. DETERMINISTIC base  — pr_report.py reads the ticket from data.json (PRs, approvals, open
#      comments, sub-tasks, timeline) and writes reports/<KEY>.json. No AI, no network. Always runs.
#   2. AI ENRICHMENT       — the connector agent (cursor-agent by default: the same MCP servers and
#      skills you use in Cursor — Jira, Bitbucket diff, Confluence, Dynatrace, all read-only) rewrites
#      the report in place with evidence chains, per-file change assessment, risks and a release gate.
#      Skipped with --no-ai / SKIP_REPORT_AI=1 / AI usage None in Settings.
#      SKIP_SUMMARY=1 only skips the fetch-container summary agent; it does NOT skip report AI.
#
# Output: jira-intern/reports/<KEY>.json  (+ reports/index.js for file:// via sync-reports.mjs).
# Exit codes: 0 ok · 2 ticket has no PR / not found.
set -o pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
[ -f "$HOME/.zprofile" ] && . "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.zshrc" ]    && . "$HOME/.zshrc"    2>/dev/null

KEY="${1:-}"; shift || true
IF_NEEDED=0; NO_AI=0
for a in "$@"; do
  case "$a" in
    --if-needed) IF_NEEDED=1 ;;
    --no-ai) NO_AI=1 ;;
  esac
done
if ! [[ "$KEY" =~ ^[A-Za-z][A-Za-z0-9]+-[0-9]+$ ]]; then
  echo "usage: pr-report.sh <TICKET-KEY> [--if-needed] [--no-ai]" >&2; exit 2
fi
KEY="$(echo "$KEY" | tr '[:lower:]' '[:upper:]')"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERN_DIR="$(cd "$HERE/.." && pwd)"
GIT_ROOT="$(cd "$HERE/../../.." && pwd)"
REPORTS_DIR="$INTERN_DIR/reports"; mkdir -p "$REPORTS_DIR"
LOG_DIR="$INTERN_DIR/logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/report-$KEY-$(date +%Y%m%d-%H%M%S).log"
PY="$INTERN_DIR/pr_report.py"
PROMPT_FILE="$INTERN_DIR/prompts/pr-readiness-prompt.md"

# Portable config (see run-intern.sh for the pattern) — connector, model, timeout, MCP policy.
AGENT_CONNECTOR=cursor; AGENT_BIN=cursor-agent; AGENT_BIN_FALLBACKS="$HOME/.local/bin/cursor-agent"
AGENT_PROMPT_FLAG='-p'; AGENT_EXTRA_ARGS='--output-format text --force'; AGENT_MODEL_FLAG='--model'
AGENT_SECRETS="$HOME/.cursor/mcp-secrets.env"; MODEL_REPORT=auto; TIMEOUT_REPORT=600
command -v node >/dev/null 2>&1 && eval "$(node "$HERE/config.mjs" shellenv 2>/dev/null)"
if [ -f "$AGENT_SECRETS" ]; then set -a; . "$AGENT_SECRETS"; set +a; fi
REPORT_MODEL="${REPORT_MODEL:-$MODEL_REPORT}"

[ -f "$INTERN_DIR/data.json" ] || { echo "$(date): no data.json — run the fetch first." | tee -a "$LOG"; exit 2; }

# Skip when the stored report already matches the ticket's current PR fingerprint.
if [ "$IF_NEEDED" = "1" ] && python3 "$PY" uptodate "$KEY" >/dev/null 2>&1; then
  echo "$(date): $KEY report is up to date — nothing to do" | tee -a "$LOG"; exit 0
fi

# Mark "generating" for the board (served mode merges this with its own queue; file:// reads it via
# sync-reports.mjs). Always cleared on exit.
python3 "$PY" status-add "$KEY" "$$" >/dev/null 2>&1 || true
cleanup() { python3 "$PY" status-remove "$KEY" >/dev/null 2>&1 || true; node "$HERE/sync-reports.mjs" "$INTERN_DIR" >>"$LOG" 2>&1 || true; }
trap cleanup EXIT INT TERM

# ── 1. Deterministic base ─────────────────────────────────────────────────────
echo "$(date): building deterministic base report for $KEY" | tee -a "$LOG"
if ! python3 "$PY" base "$KEY" >>"$LOG" 2>&1; then
  echo "$(date): $KEY has no pull request (or is not in data.json) — no report" | tee -a "$LOG"; exit 2
fi
node "$HERE/sync-reports.mjs" "$INTERN_DIR" >>"$LOG" 2>&1 || true   # base is visible immediately

# ── 2. AI enrichment (optional) — JIRA-AI-Intern owns this, not cursor-agent ──
if [ "$NO_AI" = "1" ] || [ -n "${SKIP_REPORT_AI:-}" ]; then
  echo "$(date): AI enrichment skipped (flag/env) — deterministic report kept" | tee -a "$LOG"; exit 0
fi
case "${REPORTS_AI_LEVEL:-moderate}" in
  none) echo "$(date): AI usage is set to None — deterministic report kept" | tee -a "$LOG"; exit 0 ;;
esac
echo "$(date): enqueueing $KEY for JIRA-AI-Intern (level=${REPORTS_AI_LEVEL:-moderate})" | tee -a "$LOG"
python3 "$INTERN_DIR/ai_queue.py" enqueue --type enrich-report --key "$KEY" --level "${REPORTS_AI_LEVEL:-moderate}" >>"$LOG" 2>&1 || {
  echo "$(date): could not enqueue AI job — deterministic report kept" | tee -a "$LOG"; exit 0
}
ls -1t "$LOG_DIR"/report-*.log 2>/dev/null | tail -n +61 | xargs rm -f 2>/dev/null || true
echo "$(date): report for $KEY base written; AI intern will enrich it — log: $LOG" | tee -a "$LOG"
exit 0
