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
#   docker run -d --name JIRA-Board -p 4321:4321 \
#     -v "$HOME/.cursor/mcp-secrets.env:/root/.cursor/mcp-secrets.env:ro" \
#     jira-board
# Then open http://localhost:4321

# Where dist/index.html comes from:
#   build    (default) — npm ci + vite build inside the image. Needs registry access
#            from the Docker VM, whose network is slow/flaky here — npm then silently
#            skips OPTIONAL platform binaries (@typescript/typescript-linux-arm64,
#            lightningcss-…), and tsc dies at "Unable to resolve …-linux-arm64".
#   prebuilt — take the dist/ the HOST already built (start-jira-board.sh runs
#            `npm run build` first and passes --build-arg DIST_SOURCE=prebuilt).
#            No npm, no network, no platform-binary roulette.
ARG DIST_SOURCE=build

# ── Stage 1a: build the board in-image ─────────────────────────────────────────
FROM node:26-bookworm-slim AS dist-build
WORKDIR /app
# Install deps first so this layer is cached until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci
# Bring in the source and produce dist/index.html (tsc --noEmit && vite build).
COPY . .
RUN npm run build

# ── Stage 1b: take the host-built board as-is ──────────────────────────────────
FROM node:26-bookworm-slim AS dist-prebuilt
WORKDIR /app
COPY dist ./dist

# The stage the runtime copies dist/ from, chosen by DIST_SOURCE.
FROM dist-${DIST_SOURCE} AS build

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime
# Container-friendly defaults; override any of these at `docker run`/compose time.
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=4321
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
COPY server ./server
COPY jira-intern ./jira-intern
COPY config ./config
# The Setup & Deployment guide, served at /docs/index.html — this is what the board's
# help (?) button opens, so it must exist inside the image, not just in the repo.
COPY docs ./docs
# The guide links to /setup/README.md (the secrets/config checklist) and its templates;
# serve.mjs allows /setup/, so the files must be in the image or those links 404.
COPY setup ./setup
COPY ai-intern/models.json ./ai-intern/models.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh \
 # Pristine copy used to seed an empty mounted volume on first boot.
 && cp -a jira-intern /opt/jira-intern-seed
EXPOSE 4321
# tini as PID 1 so `docker stop` / Ctrl+C shut down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/docker-entrypoint.sh"]
