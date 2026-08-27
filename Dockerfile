# syntax=docker/dockerfile:1
#
# My Jira Board — self-contained image.
#   • Stage 1 builds the single-file React board (dist/index.html).
#   • Stage 2 runs the zero-dependency Node server plus the Python fetch pipeline,
#     so the board serves AND refreshes itself with no host commands.
#
# Build & run:
#   docker compose up -d --build          # easiest (see docker-compose.yml)
# or:
#   docker build -t jira-board .
#   docker run -d --name jira-board -p 4321:4321 \
#     -v "$HOME/.cursor/mcp-secrets.env:/root/.cursor/mcp-secrets.env:ro" \
#     jira-board
# Then open http://localhost:4321

# ── Stage 1: build the board ───────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
# Install deps first so this layer is cached until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci
# Bring in the source and produce dist/index.html (tsc --noEmit && vite build).
COPY . .
RUN npm run build

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
# Container-friendly defaults; override any of these at `docker run`/compose time.
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=4321 \
    SKIP_SUMMARY=1 \
    REFRESH_ON_START=1 \
    REFRESH_INTERVAL=900
# python3 = the deterministic fetch; tini = clean PID 1 (reaps the Python children
# that the Refresh button spawns); ca-certificates for TLS. bash + coreutils(timeout)
# already ship in the base image and cover the runner scripts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# App server + built board + the whole intern pipeline (scripts, config, baked data).
COPY --from=build /app/dist ./dist
COPY serve.mjs package.json ./
COPY jira-intern ./jira-intern
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh \
 # Pristine copy used to seed an empty mounted volume on first boot.
 && cp -a jira-intern /opt/jira-intern-seed
EXPOSE 4321
# tini as PID 1 so `docker stop` / Ctrl+C shut down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/docker-entrypoint.sh"]
