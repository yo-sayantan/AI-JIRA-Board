# config.json — the one file to edit when porting this setup

`config.json` is the **single source of truth** for everything user-, company- and
machine-specific in the jira-board + jira-intern system. A new user creates **one file**
and everything follows: the agent prompts, the runner scripts, the local server, and the
app UI all read from it.

## Where it lives — and which copy wins

Your **real** values (your name, corporate id, internal company hostnames) must NOT sit in
the repo — this project is meant to be publishable. So the file is resolved at runtime, in
this order, first match wins:

| # | Location | Purpose |
|---|---|---|
| 1 | `$AI_CONFIG_FILE` | Explicit override — any path. Handy for CI or testing. |
| 2 | `~/.ai/config.json` | **Your personal config.** Outside every repo. This is the one you edit. |
| 3 | `jira-intern/config.json` | The tracked **template/fallback** — placeholders only, safe to commit. |

Create yours once:

```bash
mkdir -p ~/.ai
cp jira-intern/config.json ~/.ai/config.json   # then edit it with your real values
chmod 600 ~/.ai/config.json
```

Check which file is actually in effect at any time:

```bash
node jira-intern/local-runner/config.mjs path
```

Every consumer implements the same order: `local-runner/config.mjs` (`resolveConfigPath()`),
`jira-intern/_config.py` (`config_path()`), `local-runner/sync-datajs.mjs`, and `serve.mjs`.
Docker mounts `~/.ai/config.json` read-only at `/root/.ai/config.json` so the container
resolves it identically.

> **Note:** no API tokens live in `config.json` — those go in your secrets env file
> (see `setup/mcp-secrets.env.template`).

Consumed by:
- `local-runner/config.mjs` — resolver. Runners call it for shell vars (`shellenv`), rendered
  prompts (`render`, substituting the `{{TOKENS}}` below), and the MCP policy block (`policy`).
- `local-runner/*.sh` — daily / weekly / summary / per-ticket runners (connector, models, timeouts).
- `jira-board/serve.mjs` — port.
- `local-runner/sync-datajs.mjs` — injects the `app` section into `data.js` as
  `window.__JIRA_CONFIG__`, so the **built** app re-themes at runtime (no rebuild needed).

If `config.json` is missing or invalid, connector/model/timeout values fall back to the
baked-in defaults (the original cursor setup). **Node.js is required**: prompts are rendered
through `config.mjs`, and the runners refuse to launch the agent with an unrendered prompt
(no identity / no MCP policy) rather than run unsafely.

---

## `user` — who you are
| key | meaning |
|---|---|
| `name` | Your display name exactly as Jira shows it (used to match "assigned to me"). |
| `accountId` | Your corporate user id (e.g. `ABC1234`). Matched case-insensitively against assignee strings. |
| `email` | Informational. |

## `endpoints` — your company's servers
`jiraBase`, `confluenceBase`, `bitbucketBase` — base URLs, no trailing slash. Injected into
every prompt (`{{JIRA_BASE}}` etc.), so ticket/PR links and JQL all point at YOUR instances.

## `connector` — which agent CLI provides the MCP servers
`active` selects the profile: `"cursor"` (default), `"codex"`, or `"claude"` — add your own
profile object with the same keys for any other CLI.

Per-profile keys:
| key | meaning |
|---|---|
| `bin` | CLI executable name on PATH. |
| `binFallbacks` | Extra absolute paths to try (supports `~`). |
| `promptFlag` | Flag/subcommand that takes the prompt (`-p` for cursor/claude, `exec` for codex). |
| `extraArgs` | Additional args. **Each arg must not contain spaces** (they are space-joined for the shell). |
| `modelFlag` | Flag that selects a model (`--model`). |
| `secretsFile` | Env file sourced before each run (API key + MCP tokens). Never committed. |
| `apiKeyEnv` | Env var the CLI needs for headless auth (warned about when empty). |
| `install` | One-liner shown when the CLI is missing. |

The MCP **servers themselves** (jira/confluence/bitbucket) are configured in the connector's
own config (e.g. `~/.cursor/mcp.json`) — this file decides which of them the agent MAY use.

## `mcp` — allow-list + read/write policy per MCP server
```json
"jira": { "enabled": true, "read": true, "write": false }
```
- `enabled: false` → the server is FORBIDDEN (the generated policy tells the agent not to call it).
- `read: true, write: false` → READ-ONLY: query/fetch, but never create/update/delete/
  transition/comment/push on that system.
- `write: true` → write operations are also allowed when a task requires them.
- `read: false, write: false` → treated as FORBIDDEN (nothing is permitted).
- `read: false, write: true` → WRITE-ONLY (may create/update, told not to browse).

This map is rendered into the `{{MCP_POLICY}}` block of every prompt (daily, weekly,
per-ticket refresh), so tightening/loosening permissions is a config-only change.

### Prompt tokens (rendered by `config.mjs render`)
`{{USER_NAME}} {{USER_ID}} {{USER_EMAIL}} {{JIRA_BASE}} {{CONFLUENCE_BASE}} {{BITBUCKET_BASE}}
{{REQUIRED_APPROVALS}} {{MCP_POLICY}} {{INTERN_DIR}}` — the last one is machine-derived (the
absolute path of this folder), so the prompts are path-portable with zero configuration.

## `models`
| key | meaning |
|---|---|
| `main` | Model for the daily/weekly/refresh runs. `"auto"` = let the connector pick (no flag passed). Env `MODEL=` overrides per run. |
| `summary` | Model for the cheap local AI-summary pass — set a fast/cheap one (e.g. `haiku-4.5`, `gpt-4o-mini`, `gemini-2.5-flash`). Env `SUMMARY_MODEL=` overrides. |

## `timeouts` (seconds)
`dailySec` (default 1800), `weeklySec` (7200, env `TIMEOUT_SEC` overrides), `summarySec` (600),
`refreshSec` (600).

## `app` — UI/runtime settings (picked up without a rebuild)
| key | meaning |
|---|---|
| `servePort` | Port for `npm run serve` (env `PORT` overrides). |
| `requiredApprovals` | How many PR approvals count as "approved" (badge + pips). |
| `branding.tagline` | Left footer text. |
| `branding.badgeText` / `badgeUrl` / `badgeTitle` | The footer "made by" badge — put your own name/portfolio here. |

> The `app` section reaches the built app through `data.js` (`window.__JIRA_CONFIG__`), which
> is regenerated by every runner — so after editing it, run any intern job (or
> `node local-runner/sync-datajs.mjs .` from this folder) to see it in the UI.

---

## Porting checklist (new user)
0. `mkdir -p ~/.ai && cp jira-intern/config.json ~/.ai/config.json` — your personal copy,
   outside the repo. Everything below edits **that** file, never the tracked template.
1. Edit `~/.ai/config.json`: your `user`, your `endpoints`, your `connector.active` (+ its
   `secretsFile` with your API key/tokens), your `app.branding`.
2. Make sure your connector CLI has the three MCP servers (jira / confluence / bitbucket)
   configured (e.g. `~/.cursor/mcp.json` for cursor).
3. `bash local-runner/run-intern.sh` → daily data; `bash local-runner/update-completed.sh` →
   full archive; open `dist/index.html`.
