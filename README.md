# 🎫 My Jira Board

[![CI](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml/badge.svg)](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![Vite 8](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![TypeScript 7](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)
![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white)
![Node 22.12+](https://img.shields.io/badge/Node-%E2%89%A5%2022.12-339933?logo=node.js&logoColor=white)
![Docker ready](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)

A personal, beautiful replacement for staring at the Jira web UI. A background fetcher pulls the
tickets assigned to you; a fast single-page app renders them — **no Jira login, no waiting on the
browser**, and refreshing the data never rebuilds the app.

React 19 · Vite 8 · TypeScript 7 · Tailwind v4 · Motion · a Python 3.11+ fetch pipeline · a
zero-dependency Node server · an optional local-AI worker · one self-contained `dist/index.html`
you can literally double-click.

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
- **PR Readiness Report** — for every ticket with a pull request: a management-grade, colour-coded
  tabbed report (verdict + score, evidence chain, per-file change assessment, risks & release gate,
  open scope, timeline). The deterministic base is built from the fetch in seconds; the optional
  AI pass runs in the **AI-Intern** container — local Ollama by default, or Claude / Gemini /
  Cursor with your own key — and may only *add* to the report, never change the verdict.
- **Completed** — the full historical archive of every Done ticket in a full-screen dialog, grouped
  by year and month, with its own search and filters.
- **Ticket detail** — a slide-in drawer: status pipeline, PR card, description, an interactive
  acceptance-criteria checklist, comments, related issues, Confluence/docs, branch, sources.
- **Settings** — appearance, background-job cadences, AI level/backend/model, notifications, and
  nine feature switches. Served mode syncs the job and AI choices to the server so scheduled runs
  honour them.

## Quick start (Docker)

```bash
# 0. clone
git clone https://github.com/yo-sayantan/AI-JIRA-Board.git
cd AI-JIRA-Board

# 1. one-time setup — your token + your details (see setup/). Both live OUTSIDE the repo.
mkdir -p ~/.cursor ~/.ai
cp setup/mcp-secrets.env.template ~/.cursor/mcp-secrets.env   # then add your Jira token
cp setup/config.example.json      ~/.ai/config.json           # then add your name + URLs

# 2. build, fetch, and serve — three containers: JIRA-Board, AI-Ollama, AI-Intern
docker compose up -d --build

#    …or the board alone (AI is optional; Settings then shows "AI intern offline")
docker compose up -d --build jira-board
```

Open **http://localhost:4321/dist/index.html**. The container fetches once on boot, then the
built-in scheduler refreshes on the cadence you pick in **Settings → Background jobs** (defaults:
active tickets twice a day, whole board and PR reports twice a week). The port is published on
`127.0.0.1` only; see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for LAN exposure
(`BIND_IP` + `ALLOWED_HOSTS`), private-CA TLS, Linux permissions and the other run modes.

## Repository layout

```
AI-JIRA-Board/
├── README.md                ← you are here
├── LICENSE                  ← MIT
├── CLAUDE.md                ← 5-line pointer that imports docs/AGENTS.md for AI coding agents
├── .nvmrc                   ← Node 26 (package.json requires >= 22.12)
├── .github/                 ← CI (shellcheck, config validation, tests, typecheck, build, Docker smoke),
│                              Dependabot, issue & PR templates
├── open-guide.sh · open-guide.bat   ← open the guide without a server (macOS/Linux · Windows)
├── docs/                    ← 📚 documentation (every .md guide lives here)
│   ├── index.html           ←   Setup & Deployment guide (per-OS install, git/Docker commands)
│   ├── ARCHITECTURE.md      ←   containers, modules, data flow, AI queue, scheduler, locks
│   ├── DEPLOYMENT.md        ←   deploy & run: Docker / static file / live server
│   ├── USAGE.md             ←   using the board: chips, menus, Completed, Settings, shortcuts
│   ├── API.md               ←   every board-server and AI-worker HTTP route
│   ├── RUNTIME-FILES.md     ←   on-disk IPC contract, lock rules, exit codes, debugging a fetch
│   ├── SECURITY.md          ←   threat model, data flows, TLS, LAN exposure, prompt-injection boundary
│   ├── CONTRIBUTING.md      ←   dev loop, tests, the keep-in-sync contracts, recipes, PR checklist
│   ├── AGENTS.md            ←   the guide for AI coding agents
│   └── CHANGELOG.md         ←   what changed, by area
├── setup/                   ← 🔐 templates for secrets, config & MCP (no real values)
│   ├── README.md            ←   step-by-step setup guide
│   ├── mcp-secrets.env.template · config.example.json
│   ├── mcp.cursor.json.template · mcp.claude.json.template · mcp-with-secrets.sh.template
│   └── Start Jira Board.command.template   ←   macOS double-click launcher
├── config/                  ← 🧭 jira-board.config.json (tracked defaults, placeholders only) + its schema
├── src/                     ← ⚛️ the React app (compiled to dist/index.html)
├── server/                  ← 🟢 the zero-dependency Node server's modules (routes live in serve.mjs)
├── jira-intern/             ← 🐍 the fetch pipeline ("the intern"): Python scripts, shell runners,
│                              prompts, CONFIG.md, and (git-ignored) runtime data
├── ai-intern/               ← 🤖 the AI-Intern worker image: worker.py, models.json, prompts/enrich.txt
├── tests/                   ← ✅ Python unit tests (`npm run test:py`)
├── serve.mjs                ← the server's route table
├── Dockerfile · docker-compose.yml · docker-entrypoint.sh   ← containerised deploy
└── start-jira-board.sh      ← build + deploy + open, in one script (Desktop-launcher friendly)
```

> Working files (`Dockerfile`, `serve.mjs`, `start-jira-board.sh`, `vite.config.ts`) stay at the
> repo root on purpose — the Docker build and Vite config reference them by path.

## Setup

You need **one Jira Personal Access Token**; everything else is optional. Nothing personal is ever
committed — your two files live **outside this repo**:

| File | Holds | Resolution |
|---|---|---|
| `config/jira-board.config.json` | All non-secret project defaults and policy (placeholders only) | Always loaded first and schema-validated |
| `~/.cursor/mcp-secrets.env` | Your API tokens — parsed line by line, never sourced or executed | Read by the Python scripts, the shell runners and the AI worker |
| `~/.ai/config.json` (or `$AI_CONFIG_FILE`) | Sparse personal override: identity, company URLs, branding | Deep-merged over the project defaults |

Check which file is in effect with `node jira-intern/local-runner/config.mjs path`. Full
walkthrough: [`setup/README.md`](setup/README.md) · key-by-key reference:
[`jira-intern/CONFIG.md`](jira-intern/CONFIG.md).

## Develop

Needs Node **22.12+** (`.nvmrc` pins 26, matching the Docker image and CI) and Python **3.11+**.

```bash
npm install
npm run dev              # localhost:5173 — renders a SAMPLE fixture (src/fixtures.ts), every UI state
npm run build            # tsc --noEmit && vite build → dist/index.html (single self-contained file)
npm run typecheck        # tsc --noEmit
npm test                 # the Python suite (tests/) and the vitest suite
npm run test:py          # Python only · npm run test:js — vitest only
npm run config:validate  # schema-check config/jira-board.config.json (+ your override)
npm run serve            # the local server on http://localhost:4321
```

Three contracts must stay in sync when you change behaviour — `src/types.ts` ↔
`jira-intern/prompts/intern-prompt.md`, `src/lib/reportTypes.ts` ↔ `jira-intern/pr_report.py`,
`src/lib/columns.ts` ↔ `jira-intern/_jira.py`. Details and recipes:
[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md).

## Documentation

| Guide | What it covers |
|---|---|
| [`docs/index.html`](docs/index.html) | Offline Setup & Deployment guide — per-OS install, git, Docker, AI models, troubleshooting |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Docker (three containers), static file, live server; ports, LAN exposure, TLS, refresh cadence |
| [`docs/USAGE.md`](docs/USAGE.md) | The board: chips, header menus, Completed dialog, PR reports, Settings, shortcuts |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Container topology, server modules, data flow, AI queue, scheduler, locks |
| [`docs/API.md`](docs/API.md) | Every HTTP route of the board server and the AI worker, with guards and status codes |
| [`docs/RUNTIME-FILES.md`](docs/RUNTIME-FILES.md) | Every file under `jira-intern/`, the lock protocol, exit codes, how to debug a failed fetch |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, what is stored where, secrets read, data flow per AI backend, TLS, reporting |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | Dev loop, tests, keep-in-sync contracts, recipes, PR checklist |
| [`docs/AGENTS.md`](docs/AGENTS.md) | Orientation and rules for AI coding agents working in this repo |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Changes by area |
| [`setup/README.md`](setup/README.md) | Secrets, personal config, TLS, MCP templates, pre-publish checklist |
| [`jira-intern/CONFIG.md`](jira-intern/CONFIG.md) | Every configuration key and environment variable |
| [`jira-intern/README.md`](jira-intern/README.md) | The fetch pipeline from the inside |

## Publishing this repo

It's safe to push **because your secrets never enter it** — they live only in
`~/.cursor/mcp-secrets.env` (git-ignored), and fetched ticket data, reports and per-machine
settings are git-ignored too. Before going **public**, work through the checklist in
[`setup/README.md → Before you make the repo public`](setup/README.md#before-you-make-the-repo-public):
it covers staged files, the tracked config staying generic, a grep for token- and hostname-shaped
strings, and the fact that *git history* may hold strings the current tree no longer does.

---

<sub>Built to dodge JIRA · made with ☕ + a refresh button</sub>
