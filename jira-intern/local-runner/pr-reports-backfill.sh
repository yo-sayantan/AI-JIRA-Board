#!/bin/bash
# JIRA Intern — PR READINESS REPORTS for EVERY ticket that has a pull request.
#
#   bash pr-reports-backfill.sh                 # all tickets of config.reports.year (default 2026)
#   bash pr-reports-backfill.sh --year 2025     # a different year
#   bash pr-reports-backfill.sh --all-years
#   bash pr-reports-backfill.sh --force         # regenerate even if the report is current
#   bash pr-reports-backfill.sh --no-ai         # deterministic base only (fast, no agent)
#   bash pr-reports-backfill.sh --auto          # what run-intern.sh launches in the background:
#                                               #   honours config.reports.autoGenerate, caps the
#                                               #   pass at reports.maxPerRun, only stale/missing.
#
# Idempotent: a ticket is (re)generated only when it has no report yet or its PR fingerprint
# (PR ids + states + approvals + comments + updatedAt) changed since the last report.
# Single instance: .report.lock (dead-PID safe). Exit 3 if another backfill is running.
set -o pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERN_DIR="$(cd "$HERE/.." && pwd)"
LOG_DIR="$INTERN_DIR/logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/reports-backfill-$(date +%Y%m%d-%H%M%S).log"
PY="$INTERN_DIR/pr_report.py"

REPORTS_AUTO=1; REPORTS_YEAR=2026; REPORTS_MAX_PER_RUN=5
command -v node >/dev/null 2>&1 && eval "$(node "$HERE/config.mjs" shellenv 2>/dev/null)"

AUTO=0; FORCE=0; YEAR="$REPORTS_YEAR"; MAX=""; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --auto) AUTO=1 ;;
    --force) FORCE=1 ;;
    --no-ai) EXTRA+=(--no-ai) ;;
    --year) shift; YEAR="${1:-$YEAR}" ;;
    --max) shift; MAX="${1:-}" ;;
    --all-years) YEAR="" ;;
  esac
  shift
done
if [ "$AUTO" = "1" ]; then
  [ "$REPORTS_AUTO" = "0" ] && { echo "$(date): reports.autoGenerate is off — skipping" | tee -a "$LOG"; exit 0; }
  MAX="${MAX:-$REPORTS_MAX_PER_RUN}"
fi
[ -f "$INTERN_DIR/data.json" ] || { echo "$(date): no data.json yet" | tee -a "$LOG"; exit 0; }

# One backfill at a time (the reports share the agent + the status file). Stale lock = dead PID.
LOCK="$INTERN_DIR/.report.lock"
if [ -f "$LOCK" ]; then
  OLD="$(awk '{print $1}' "$LOCK" 2>/dev/null)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "$(date): another backfill (pid $OLD) is running — skipping" | tee -a "$LOG"; exit 3
  fi
  rm -f "$LOCK"
fi
echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

ARGS=(needs-report)
[ -n "$YEAR" ] && ARGS+=(--year "$YEAR")
[ "$FORCE" = "1" ] && ARGS+=(--force)
[ -n "$MAX" ] && ARGS+=(--max "$MAX")
KEYS="$(python3 "$PY" "${ARGS[@]}" 2>>"$LOG")"
if [ -z "$KEYS" ]; then
  echo "$(date): every ${YEAR:-any-year} ticket with a PR already has a current report" | tee -a "$LOG"; exit 0
fi
COUNT="$(printf '%s\n' "$KEYS" | wc -l | tr -d ' ')"
AI_LABEL=on; [ "${#EXTRA[@]}" -gt 0 ] && AI_LABEL=off
echo "$(date): generating $COUNT PR readiness report(s) [year=${YEAR:-all} max=${MAX:-none} ai=$AI_LABEL]" | tee -a "$LOG"

OK=0; FAIL=0
while IFS= read -r KEY; do
  [ -z "$KEY" ] && continue
  echo "$(date): ── $KEY" | tee -a "$LOG"
  if bash "$HERE/pr-report.sh" "$KEY" "${EXTRA[@]}" >>"$LOG" 2>&1; then OK=$((OK+1)); else FAIL=$((FAIL+1)); fi
done <<< "$KEYS"

node "$HERE/sync-reports.mjs" "$INTERN_DIR" >>"$LOG" 2>&1 || true
ls -1t "$LOG_DIR"/reports-backfill-*.log 2>/dev/null | tail -n +21 | xargs rm -f 2>/dev/null || true
echo "$(date): backfill done — $OK ok, $FAIL failed — log: $LOG" | tee -a "$LOG"
[ "$FAIL" = "0" ]
