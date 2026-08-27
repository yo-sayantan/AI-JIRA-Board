#!/usr/bin/env bash
# Start / rebuild / redeploy My Jira Board in Docker.
#
# Always uses ONE fixed host port (PORT below). Triggering this script many times
# never picks a new port — it stops whatever is using that port, rebuilds the
# image, and redeploys the same container name on the same port.
#
# Usage:
#   ./start-jira-board.sh
#   PORT=4321 ./start-jira-board.sh
# Or double-click the Desktop shortcut (Start My Jira Board.command).
set -euo pipefail

# ── Fixed port — never auto-increment. Change here (or via env) only. ─────────
PORT="${PORT:-4321}"
CONTAINER_NAME="jira-board"
IMAGE_NAME="jira-board:latest"
APP_URL="http://localhost:${PORT}/dist/index.html"

# Resolve the repo this script lives in (works even when launched from Desktop).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR"

log()  { printf '\n▶  %s\n' "$*"; }
ok()   { printf '   ✓ %s\n' "$*"; }
die()  { printf '\n✖  %s\n' "$*" >&2; exit 1; }

# Keep the Terminal window open when double-clicked from Desktop.
PAUSE_AT_END=0
if [ -t 0 ] && [ "${KEEP_OPEN:-0}" = "1" ]; then PAUSE_AT_END=1; fi
trap 'code=$?; if [ "$PAUSE_AT_END" = "1" ]; then echo; read -r -p "Press Enter to close… "; fi; exit $code' EXIT

# ── 1. Docker daemon ──────────────────────────────────────────────────────────
ensure_docker() {
  if docker info >/dev/null 2>&1; then
    ok "Docker is already running"
    return
  fi
  log "Starting Docker Desktop…"
  open -a Docker 2>/dev/null || die "Docker Desktop is not installed (or 'open -a Docker' failed)."
  # Wait up to ~2 minutes for the daemon socket.
  for i in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      ok "Docker is ready"
      return
    fi
    sleep 2
  done
  die "Docker Desktop did not become ready in time. Open it manually and try again."
}

# ── 2. Free the dedicated port (and any prior jira-board container) ───────────
# Multiple clicks must never stack containers on new ports — always reclaim PORT.
free_port() {
  log "Reclaiming dedicated port ${PORT}…"

  # Prefer the known container name first (compose / previous runs of this script).
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    ok "Removed existing container '${CONTAINER_NAME}'"
  fi

  # Also stop anything else still bound to PORT (stale compose project, old test run, …).
  local ids
  ids="$(docker ps -q --filter "publish=${PORT}" 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null 2>&1 || true
    ok "Stopped other container(s) publishing port ${PORT}"
  fi

  # Host-side process (e.g. a leftover `node serve.mjs`) must not steal the port either.
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      sleep 1
      ok "Freed host process(es) listening on ${PORT}"
    fi
  fi
}

# ── 3. Build + deploy ─────────────────────────────────────────────────────────
deploy() {
  cd "$REPO_DIR"
  [ -f Dockerfile ] || die "No Dockerfile in ${REPO_DIR}"
  [ -f docker-compose.yml ] || die "No docker-compose.yml in ${REPO_DIR}"

  log "Building image ${IMAGE_NAME} (this can take a minute the first time)…"
  # Compose reads PORT from the environment for the published port mapping.
  export PORT
  docker compose build --pull 2>&1 | tail -n 20
  ok "Image built"

  log "Deploying container '${CONTAINER_NAME}' on port ${PORT}…"
  # --force-recreate: even if the container already exists with the same config, replace it.
  # --remove-orphans: drop stray services from older compose files.
  docker compose up -d --force-recreate --remove-orphans
  ok "Container started"
}

# ── 4. Health check + open the board ──────────────────────────────────────────
wait_ready() {
  log "Waiting for the board on ${APP_URL}…"
  for i in $(seq 1 30); do
    if curl -sf -m 2 "http://127.0.0.1:${PORT}/api/intern-status" >/dev/null 2>&1; then
      ok "Board is up"
      return
    fi
    # Container crashed? Surface why.
    if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
      echo
      docker logs "$CONTAINER_NAME" 2>&1 | tail -n 40 || true
      die "Container '${CONTAINER_NAME}' is not running. See logs above."
    fi
    sleep 1
  done
  die "Board did not respond on port ${PORT} in time. Try: docker logs ${CONTAINER_NAME}"
}

# ── Main ──────────────────────────────────────────────────────────────────────
printf '\n🎫  My Jira Board — Docker deploy\n'
printf '    repo: %s\n' "$REPO_DIR"
printf '    port: %s  (fixed — same every run)\n' "$PORT"

ensure_docker
free_port
deploy
wait_ready

log "Opening ${APP_URL}"
open "$APP_URL" 2>/dev/null || true

printf '\n════════════════════════════════════════════════════════\n'
printf '  Board:     %s\n' "$APP_URL"
printf '  Port:      %s  (dedicated — never changes)\n' "$PORT"
printf '  Container: %s\n' "$CONTAINER_NAME"
printf '  Logs:      docker logs -f %s\n' "$CONTAINER_NAME"
printf '  Stop:      docker compose -f %s/docker-compose.yml down\n' "$REPO_DIR"
printf '════════════════════════════════════════════════════════\n\n'
ok "Done. Click this script again anytime — it will rebuild and redeploy on the same port."
