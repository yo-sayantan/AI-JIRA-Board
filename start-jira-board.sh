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
COMPOSE_PROJECT_NAME="jira-project"
CONTAINER_NAME="JIRA-Board"
IMAGE_NAME="jira-board:latest"
PROJECT_LABEL="JIRA-Project"
# Prior names from earlier deploys — remove so the new stack can take the port.
STALE_CONTAINERS=(
  JIRA-Project JIRA-Board
  JIRA-AI-Intern AI-Intern
  JIRA-AI-Ollama AI-Ollama
)
APP_URL="http://localhost:${PORT}/dist/index.html"
export COMPOSE_PROJECT_NAME

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

  # Prefer known container names first (compose / previous runs of this script).
  local name
  for name in "${STALE_CONTAINERS[@]}"; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
      docker rm -f "$name" >/dev/null 2>&1 || true
      ok "Removed existing container '${name}'"
    fi
  done

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

  # Build dist/ on the HOST when the toolchain is here. The Docker VM's network is too
  # slow/flaky for in-image npm ci (it silently drops optional platform binaries and tsc
  # dies on "@typescript/typescript-linux-arm64"), so the image then just packages dist/.
  DIST_SOURCE=build
  if command -v npm >/dev/null 2>&1 && [ -d node_modules ]; then
    log "Building the board on the host (npm run build)…"
    if npm run build 2>&1 | tail -n 5 && [ -f dist/index.html ]; then
      DIST_SOURCE=prebuilt
      ok "Host build OK — the image will package dist/ as-is"
    else
      log "Host build failed — falling back to the in-image build"
    fi
  else
    log "npm or node_modules missing on the host — building inside the image"
  fi

  log "Building image ${IMAGE_NAME} (this can take a minute the first time)…"
  # Compose reads PORT from the environment for the published port mapping.
  # COMPOSE_PROJECT_NAME groups the stack in Docker Desktop as JIRA-Project.
  # No --pull: Docker Hub is painfully slow from this VM and the base image is cached.
  export PORT
  docker compose -p jira-board down --remove-orphans >/dev/null 2>&1 || true
  docker compose build --build-arg DIST_SOURCE="$DIST_SOURCE" 2>&1 | tail -n 20
  ok "Image built (dist: ${DIST_SOURCE})"

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
printf '\n🎫  %s — Docker deploy\n' "$PROJECT_LABEL"
printf '    repo: %s\n' "$REPO_DIR"
printf '    port: %s  (fixed — same every run)\n' "$PORT"

ensure_docker
free_port
deploy
wait_ready

log "Opening ${APP_URL}"
open "$APP_URL" 2>/dev/null || true

printf '\n════════════════════════════════════════════════════════\n'
printf '  Project:   %s\n' "$PROJECT_LABEL"
printf '  Board:     %s\n' "$APP_URL"
printf '  Port:      %s  (dedicated — never changes)\n' "$PORT"
printf '  Containers: JIRA-Board, AI-Intern, AI-Ollama\n'
printf '  Logs:      docker logs -f %s\n' "$CONTAINER_NAME"
printf '  Stop:      docker compose -f %s/docker-compose.yml down\n' "$REPO_DIR"
printf '════════════════════════════════════════════════════════\n\n'
ok "Done. Click this script again anytime — it will rebuild and redeploy on the same port."
