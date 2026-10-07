# 🎫 My Jira Board

[![CI](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml/badge.svg)](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)
![Docker ready](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)

A personal, self-hosted replacement for staring at the Jira web UI. A background fetcher pulls
your tickets; a fast single-file React app renders them — no Jira login, no waiting on the
browser, and refreshing the data never rebuilds the app.

```bash
git clone https://github.com/yo-sayantan/AI-JIRA-Board.git && cd AI-JIRA-Board
mkdir -p ~/.cursor ~/.ai
cp setup/mcp-secrets.env.template ~/.cursor/mcp-secrets.env   # add your Jira token
cp setup/config.example.json      ~/.ai/config.json           # add your name + URLs
bash start-jira-board.sh                                      # build, deploy, open :4321
```

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
