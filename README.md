# 🎫 My Jira Board

[![CI](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml/badge.svg)](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)
![Docker ready](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)
![AI](https://img.shields.io/badge/AI-local%20%26%20cloud-8b5cf6)

### Your Jira, without the Jira UI — fast, private, and AI-assisted.

A self-hosted kanban board that mirrors **your** Jira tickets and pull requests in one place.
Open it and everything is already there: no login, no spinner, no waiting on a slow web app.
Drag a card to change its status **in Jira**, see which PRs are ready to ship, and let an AI
write the briefings you would otherwise piece together from five tabs.

> **One command to install. Your data never leaves your machine** (unless you choose a cloud AI).

```bash
git clone https://github.com/yo-sayantan/AI-JIRA-Board.git && cd AI-JIRA-Board
mkdir -p ~/.cursor ~/.ai
cp setup/mcp-secrets.env.template ~/.cursor/mcp-secrets.env   # add your Jira token
cp setup/config.example.json      ~/.ai/config.json           # add your name + URLs
bash scripts/start-jira-board.sh                                      # build, deploy, open :4321
```

## ✨ Why you'll like it

| | |
|---|---|
| ⚡ **Instant** | A single-file React app reads a local snapshot. Refreshing data never rebuilds the app. |
| 🖱️ **Drag to update Jira** | Drop a card on To Do / In Progress / In Review / QA / Done — the ticket moves in Jira, in the background, while you keep working. |
| 🛡️ **Guard-rails built in** | The **QA lane** only takes QA tickets (and keeps them among QA · QA In Progress · Blocked · On Hold · Done), **In Review needs a PR**, and **Done needs every PR merged or declined plus a QA ticket** — a zone that won't take the card says why while you drag, ⌥-drop forces past a PR / QA rule, and every move has **Undo**. Checked against live Jira, not just the cached data. |
| 🤖 **AI that explains the work** | Per-ticket briefs and **PR Readiness Reports** with a ship / no-ship verdict, evidence, risks and file-by-file notes. |
| 🔒 **Private by default** | Local AI (Ollama) means no tokens and no data leaving the box. Loopback-only, non-root containers, verified TLS. |
| 🧩 **Works with what you have** | Jira + Bitbucket (on-prem or cloud). Cursor, Gemini or Claude for cloud AI. No lock-in. |

## 📋 Everything it does

**Board & workflow**
- Six-column kanban — **To Do · Blocked · In Progress · In Review · QA · Done** — with an **On Hold** drop space under Blocked and a **Next Sprint** section; empty columns fold to slim rails so the busy ones get the width; sprint-carry-over markers, priority and story-point glyphs, PR badges with approval counts.
- **Drag-and-drop status changes** written through to Jira, with live PR / QA gates and automatic bounce-back.
- Smart search (`FIDM-6115`, bare numbers, people, branches, PR ids) and one-click stat chips.
- **Completed archive** — your whole delivery history by year and month, with lead-time vs dev-time.
- **Raised by me** — every ticket you filed, who holds it now, and the full hand-off trail.
- Toasts that appear instantly and queue politely (you choose how many and for how long).

**🤖 AI features**
- **AI briefs** — a deep summary on To Do / In Progress tickets (enriched from linked Confluence pages, related tickets and PR diffs) and a short one for review/QA.
- **PR Readiness Reports** — ship / no-ship verdict, evidence chain, release gates (approvals, comments, QA, scans), and file-level notes. Deterministic base report always available; AI enrichment layered on top.
- **Four AI levels** — None · Low · Moderate · Max — trading speed and cost for depth.
- **Local or Cloud, your choice** — run a model on your own machine (Gemma, Qwen, Llama, Phi… catalog included) or use **Cursor, Gemini or Claude** with a value-priced model shortlist and a built-in [price table](docs/index.html#ai-cloud-prices).
- **Smart Ollama management** — the local-model container only runs when you switch it on *and* a model is present; it starts and stops itself as you change settings.
- **Model manager** — pick a model, click download, watch progress; or drop in your own `.gguf`.

**Operate it your way**
- **Settings that matter** — appearance (auto / light / dark / scheduled), schedules for background refreshes, parallelism, notification behaviour, and a feature toggle for every section.
- **Background jobs** — scheduled active refresh, full-board rebuild and report refresh; per-ticket refresh from any card.
- **Docker, static file, or live server** — the same board runs from a double-click or a container.
- **Guide built in** — a styled setup & deployment guide with per-OS commands, model downloads and a prices table, one click from Settings.

## 🧠 Local AI (the AI-Ollama container)

The `AI-Ollama` container is **off by default on every boot and deploy** and only runs while **both** hold:

1. **Settings → AI → "AI-Ollama container" is on**, and
2. **`jira-intern/models/` contains a model** — a model pulled from the Settings list (that directory *is* Ollama's store), or a `.gguf` file you place there yourself (then register it once: `docker exec AI-Ollama ollama create <tag> -f /root/.ollama/Modelfile`, see `jira-intern/models/README.md`).

Turn the toggle on and the container starts within seconds (if a model is present — otherwise the board tells you what is missing); turn it off and it stops. Cloud AI never needs it. Details: [`docs/RUNTIME.md`](docs/RUNTIME.md#ai-ollama-lifecycle).

## 🚀 Get started in minutes

1. Follow the five commands at the top, or open the in-app **?** guide.
2. Open **http://localhost:4321** — your board is already populated.
3. Optional: Settings → **AI** to pick *Local* or *Cloud*; Settings → **Features** to shape the board.

Need help? The [Setup & Deployment guide](docs/index.html) covers Windows, macOS and Linux, and the [FAQ](docs/index.html#faq) answers the usual snags.

## 📚 All documentation lives in [`docs/`](docs/)

| Start here | |
|---|---|
| [`docs/index.html`](docs/index.html) | **Setup & Deployment guide** — per-OS install, copy-ready commands, FAQ (also the board's **?** button) |
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | What it does, quick start, repository layout |
| [`docs/AGENTS.md`](docs/AGENTS.md) | **Onboarding for engineers & AI agents** — repo map, golden rules, worked example, gotchas |

| Deep dives | |
|---|---|
| [`docs/FEATURES.md`](docs/FEATURES.md) | Every feature and where its code lives |
| [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md) | Every file, writer, lock and lifecycle |
| [`docs/AI-PIPELINE.md`](docs/AI-PIPELINE.md) | Briefs, report enrichment, models, queues |
| [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) | Jira/Bitbucket, the full HTTP API, config chain |
| [`docs/RUNTIME.md`](docs/RUNTIME.md) | Containers, agents, queues, schedulers, runbook |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the fetch, data file and app fit together |
| [`docs/INTERN.md`](docs/INTERN.md) | The fetch pipeline (`jira-intern/`) from the inside |

| Operating it | |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Secrets, personal config, MCP templates, the public-repo checklist |
| [`docs/CONFIG.md`](docs/CONFIG.md) | Key-by-key reference for `config/jira-board.config.json` |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Docker / static file / live server, deploy pitfalls |
| [`docs/USAGE.md`](docs/USAGE.md) | Using the board: chips, Raised by me, Next Sprint, the drawer |
| [`docs/legal.html`](docs/legal.html) | Privacy, your data, cookies, terms, accessibility, contact |

When the board is running, every page above is served styled at
`http://localhost:4321/docs/` (markdown renders through `docs/doc.html`).

---

<sub>Built to dodge JIRA · made with ☕ + a refresh button · MIT</sub>
