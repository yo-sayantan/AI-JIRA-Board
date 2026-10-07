#!/bin/bash
# Raised-by-me refresh. Re-fetches ONLY raised[] (every non-sub-task ticket I reported)
# and merges it into data.json (then re-syncs data.js). Invoked by serve.mjs
# POST /api/run-raised — the refresh button inside the board's "Raised by me" view.
#
# Deliberately deterministic-only (daily_fetch.py --raised): one JQL search, no Bitbucket,
# no agent fallback — these tickets don't need code enrichment, just status + assignee.
set -o pipefail

# shellcheck source=runner-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/runner-env.sh"
load_agent_secrets
LOG="$LOG_DIR/refresh-raised-$(date +%Y%m%d-%H%M%S).log"

# This rewrites the SHARED data.json; our own .raised.lock keeps two of these apart.
refuse_if_locked "raised refresh" "$INTERN_DIR/.intern.lock" "$INTERN_DIR/.completed.lock" "$INTERN_DIR/.refresh.lock" "$INTERN_DIR/.raised.lock"
RAISED_LOCK="$INTERN_DIR/.raised.lock"
echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RAISED_LOCK"
trap 'rm -f "$RAISED_LOCK"' EXIT INT TERM

if ! command -v python3 >/dev/null 2>&1 || [ ! -f "$INTERN_DIR/daily_fetch.py" ]; then
  echo "$(date): python3 or daily_fetch.py missing — cannot refresh raised tickets" | tee -a "$LOG"
  exit 127
fi

# Same parallelism knob as the board refresh (Settings → Parallel refresh); shellenv
# assigns it, python reads it from the environment.
export REFRESH_WORKERS
echo "$(date): refreshing raised-by-me tickets (daily_fetch.py --raised, workers=${REFRESH_WORKERS:-8})…" | tee -a "$LOG"
run_with_timeout 300 python3 "$INTERN_DIR/daily_fetch.py" --raised >> "$LOG" 2>&1
code=$?

# Python write_outputs already wrote data.js; this is just the safety net.
sync_datajs

echo "$(date): raised refresh finished (exit $code) — log: $LOG" | tee -a "$LOG"
exit "$code"
