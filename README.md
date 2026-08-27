# 🎫 My Jira Board

[![CI](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml/badge.svg)](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![Vite 6](https://img.shields.io/badge/Vite-6-646cff?logo=vite&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white)
![Docker ready](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)

A personal, beautiful replacement for staring at the Jira web UI. A background fetcher pulls the
tickets assigned to you; a fast single-page app renders them — **no Jira login, no waiting on the
browser**, and refreshing the data never rebuilds the app.

React 19 · Vite 6 · Tailwind v4 · Motion · a Python fetch pipeline · one self-contained
`dist/index.html` you can literally double-click.

> **New here?** Open the **Setup & Deployment guide** — requirements, per-OS install steps
> (Windows/macOS/Linux), git & Docker commands, and troubleshooting, all copy-ready:
>
> | | |
> |---|---|
> | **macOS / Linux** | `./open-guide.sh` |
> | **Windows** | double-click `open-guide.bat` |
> | **Any OS** | open [`docs/index.html`](docs/index.html) directly |
> | **Board running?** | click the **?** button in the header |
>
> It needs nothing installed — it's the page to reach for when the board *won't* start.

---

## What it does

- **Kanban board** — To Do · In Progress · In Review (folds in Ready4Review + Code Review) · QA ·
  Done. Colour-coded animated cards; click any for a full detail drawer. Chips filter; live search.
- **On Hold** — its own section, shown only when something is blocked/waiting.
- **Next Sprint** — tickets queued in a sprint that hasn't started yet, kept out of To Do so a
  cleared sprint doesn't look full. Toggle it from the top chips; **All** reveals everything at once.
- **Completed** — the full historical archive of every Done ticket, with inline peek + detail.
- **Ticket detail** — a slide-in drawer: status pipeline, PR card, description, an interactive
  acceptance-criteria checklist, comments, related issues, Confluence/docs, branch, sources.

## Quick start (Docker)

```bash
# 0. clone
git clone https://github.com/yo-sayantan/AI-JIRA-Board.git
cd AI-JIRA-Board

# 1. one-time setup — your token + your details (see setup/). Both live OUTSIDE the repo.
mkdir -p ~/.cursor ~/.ai
cp setup/mcp-secrets.env.template ~/.cursor/mcp-secrets.env   # then add your Jira token
cp jira-intern/config.json        ~/.ai/config.json           # then add your name + URLs

# 2. build, fetch, and serve
docker compose up -d --build
```

Open **http://localhost:4321/dist/index.html**. That's it — the container fetches on start and
auto-refreshes every 15 minutes. Full details and other run modes: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Repository layout

```
AI-JIRA-Board/
├── README.md                ← you are here
├── LICENSE                  ← MIT
├── .github/                 ← CI (typecheck + build), Dependabot, issue & PR templates
├── open-guide.sh            ← open the guide (macOS/Linux) — no server needed
├── open-guide.bat           ← open the guide (Windows) — no server needed
├── docs/                    ← 📚 documentation
│   ├── index.html           ←   Setup & Deployment guide (per-OS install, git/Docker commands)
│   ├── ARCHITECTURE.md      ←   how the fetch, data file, and app fit together
│   ├── DEPLOYMENT.md        ←   deploy & run: Docker / static file / live server
│   └── USAGE.md             ←   using the board: chips, Next Sprint, drawer, shortcuts
├── setup/                   ← 🔐 templates for secrets, config & MCP (no real values)
│   ├── README.md            ←   step-by-step setup guide
│   ├── mcp-secrets.env.template
│   ├── config.example.json
│   ├── mcp.cursor.json.template  ·  mcp.claude.json.template  ·  mcp-with-secrets.sh.template
│   └── Start Jira Board.command.template   ←   macOS double-click launcher
├── src/                     ← ⚛️ the React app (compiled to dist/index.html)
├── jira-intern/             ← 🐍 the fetch pipeline ("the intern") + its config
├── serve.mjs                ← optional zero-dep server for live mode
├── Dockerfile · docker-compose.yml · docker-entrypoint.sh   ← containerised deploy
└── start-jira-board.sh      ← build + deploy + open, in one script (Desktop-launcher friendly)
```

> Working files (`Dockerfile`, `serve.mjs`, `start-jira-board.sh`, `vite.config.ts`) stay at the
> repo root on purpose — the Docker build and Vite config reference them by path.

## Setup

You need **one Jira Personal Access Token**; everything else is optional. Nothing personal is ever
committed — both of your files live **outside this repo**:

| File | Holds | Resolution |
|---|---|---|
| `~/.cursor/mcp-secrets.env` | Your API tokens | referenced by path from `config.json` |
| `~/.ai/config.json` | Your name, corporate id, company URLs, branding | `$AI_CONFIG_FILE` → `~/.ai/config.json` → the tracked `jira-intern/config.json` template |

The `jira-intern/config.json` in this repo contains **placeholders only** and acts as the fallback,
so a fresh clone runs without breaking and your real values never enter git. Check which file is in
effect with `node jira-intern/local-runner/config.mjs path`. Full walkthrough:
[`setup/README.md`](setup/README.md) · key-by-key reference: [`jira-intern/CONFIG.md`](jira-intern/CONFIG.md).

## Develop

```bash
npm install
npm run dev        # localhost:5173 — renders a SAMPLE fixture (src/fixtures.ts), every UI state
npm run build      # → dist/index.html (single self-contained file)
npm run typecheck  # tsc --noEmit
```

`src/types.ts` is the **data contract** — the single source of truth for the ticket shape, mirrored
in prose by `jira-intern/prompts/intern-prompt.md`. Keep the two in sync. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full picture.

## Publishing this repo

It's safe to push **because your secrets never enter it** — they live only in
`~/.cursor/mcp-secrets.env` (git-ignored). Before going **public**, confirm no `*.env` with real
values is staged and sanitize or untrack `jira-intern/config.json` (it holds your name and internal
hostnames). Checklist: [`setup/README.md → Before you make the repo public`](setup/README.md#before-you-make-the-repo-public).

---

<sub>Built to dodge JIRA · made with ☕ + a refresh button</sub>
