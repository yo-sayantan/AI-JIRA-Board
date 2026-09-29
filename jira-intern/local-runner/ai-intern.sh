#!/usr/bin/env bash
# Entrypoint of the JIRA-AI-Intern container (see docker-compose.yml → jira-ai).
#
# Loads the mounted secrets (cloud API keys, the Bitbucket token used to read PR diffs) exactly
# the way the board container does, then hands over to the worker loop. `exec` so the Python
# process is tini's direct child and `docker stop` reaches it cleanly.
set -u
APP_DIR="${APP_DIR:-/app}"
INTERN_DIR="$APP_DIR/jira-intern"

SECRETS="${AGENT_SECRETS:-$HOME/.cursor/mcp-secrets.env}"
if [ -f "$SECRETS" ]; then
  echo "[ai-intern] loading secrets from $SECRETS"
  set -a; . "$SECRETS"; set +a
else
  echo "[ai-intern] no secrets file at $SECRETS — cloud mode will have no API key, Bitbucket diffs are skipped"
fi

exec python3 "$INTERN_DIR/ai_intern.py"
