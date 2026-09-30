#!/usr/bin/env bash
# Shared environment for the local-runner jobs. Source it, do not run it:
#   . "$(dirname "${BASH_SOURCE[0]}")/runner-env.sh"
#
# Launchd, Mac Shortcuts and the Docker entrypoint start with a minimal environment, so this
# restores PATH and the shell profile, then loads the central config (config.mjs shellenv).

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
[ -f "$HOME/.zprofile" ] && . "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.zshrc" ]    && . "$HOME/.zshrc"    2>/dev/null

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERN_DIR="$(cd "$HERE/.." && pwd)"
GIT_ROOT="$(cd "$HERE/../../.." && pwd)"
LOG_DIR="$INTERN_DIR/logs"; mkdir -p "$LOG_DIR"

# Fallbacks for a machine without node; config.mjs shellenv overrides every one of them.
AGENT_CONNECTOR=cursor; AGENT_BIN=cursor-agent; AGENT_BIN_FALLBACKS="$HOME/.local/bin/cursor-agent"
AGENT_PROMPT_FLAG='-p'; AGENT_EXTRA_ARGS='--output-format text --force'; AGENT_MODEL_FLAG='--model'
AGENT_SECRETS="$HOME/.cursor/mcp-secrets.env"; AGENT_API_KEY_ENV='CURSOR_API_KEY'
AGENT_INSTALL_HINT='curl https://cursor.com/install -fsS | bash'
MODEL_MAIN=auto; TIMEOUT_DAILY=1800; TIMEOUT_WEEKLY=7200; TIMEOUT_REFRESH=600; REQUIRED_APPROVALS=2
command -v node >/dev/null 2>&1 && eval "$(node "$HERE/config.mjs" shellenv 2>/dev/null)"

TIMEOUT_BIN="$(command -v timeout || command -v gtimeout)"

# shellcheck source=lock-util.sh
. "$HERE/lock-util.sh"

# Jira / Bitbucket / connector tokens, exported to child processes.
load_agent_secrets() {
  if [ -f "$AGENT_SECRETS" ]; then set -a; . "$AGENT_SECRETS"; set +a; fi
}

# Every data.json writer refuses to start while another one holds its lock (exit 3), so two
# jobs never interleave writes. Stale locks (dead PID, Docker recreate) are cleared first.
refuse_if_locked() {
  local what="$1" lock
  shift
  for lock in "$@"; do
    lock_clear_stale "$lock"
    if lock_is_held "$lock"; then
      echo "$(date): $(basename "$lock") held by another intern job — skipping $what" | tee -a "$LOG"
      exit 3
    fi
  done
}

run_with_timeout() {
  local secs="$1"
  shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$secs" "$@"; else "$@"; fi
}

# Sets AGENT to the connector CLI; returns 1 when it is not installed.
find_agent() {
  AGENT="$(command -v "$AGENT_BIN")"
  if [ -z "$AGENT" ]; then
    local fallbacks f
    IFS=':' read -r -a fallbacks <<< "$AGENT_BIN_FALLBACKS"
    for f in "${fallbacks[@]}"; do [ -x "$f" ] && AGENT="$f" && break; done
  fi
  [ -n "$AGENT" ]
}

# The agent command line for a prompt, with the model flag unless the model is "auto".
agent_command() {
  RUN=( "$AGENT" "$AGENT_PROMPT_FLAG" "$1" $AGENT_EXTRA_ARGS )
  local model="${MODEL:-$MODEL_MAIN}"
  [ -n "$model" ] && [ "$model" != "auto" ] && RUN+=( "$AGENT_MODEL_FLAG" "$model" )
}

# data.js must always match data.json; the board loads it directly on file://.
sync_datajs() {
  [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1 || return 0
  if node "$HERE/sync-datajs.mjs" "$INTERN_DIR" 2>>"$LOG"; then
    echo "$(date): regenerated data.js from data.json" | tee -a "$LOG"
  else
    echo "$(date): WARNING could not regenerate data.js (is data.json valid JSON?)" | tee -a "$LOG"
  fi
}
