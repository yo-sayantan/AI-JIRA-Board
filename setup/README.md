# Setup — secrets, config & MCP

Everything user-, company- and token-specific lives **outside** the app bundle. This folder
holds a safe **template** for each of those files. Nothing here contains a real token — you
copy a template, fill it in on your machine, and keep your filled-in copies out of git.

> **The golden rule:** the only file that ever holds a real token is your
> `mcp-secrets.env`, and it lives **outside this repo** (default `~/.cursor/mcp-secrets.env`).
> Everything else points at it by path. The file is **parsed line by line, never sourced**:
> `KEY=value`, optional quotes, `#` comments; `$VAR`, `$(…)` and backticks are taken literally.

| Template in this folder | Copy it to | What it is |
|---|---|---|
| [`mcp-secrets.env.template`](mcp-secrets.env.template) | `~/.cursor/mcp-secrets.env` | Your API tokens (Jira required; Confluence/Bitbucket and AI keys optional). |
| [`config.example.json`](config.example.json) | `~/.ai/config.json` | Who you are + your company URLs + preferences. **No tokens.** Lives outside the repo. |
| [`mcp.cursor.json.template`](mcp.cursor.json.template) | `~/.cursor/mcp.json` | MCP servers for Cursor (optional — only for the agent fallback). |
| [`mcp.claude.json.template`](mcp.claude.json.template) | `~/.claude/.claude.json` | MCP servers for Claude Code (optional). |
| [`mcp-with-secrets.sh.template`](mcp-with-secrets.sh.template) | `~/.local/bin/mcp-with-secrets.sh` | Wrapper that keeps tokens out of the MCP JSON. |
| [`Start Jira Board.command.template`](Start%20Jira%20Board.command.template) | `~/Desktop/Start Jira Board.command` | macOS double-click launcher. |

---

## What you actually need

The board has **three moving parts**, and they need different things:

1. **The fetch** (`jira-intern/`) — pulls your tickets. Needs **one Jira token**. That's the
   only hard requirement. Confluence and Bitbucket tokens are optional and just add richer
   detail (linked docs, real branches, PR state).
2. **The app** (`src/` → `dist/index.html`) — renders whatever the fetch dumped. Needs **nothing**.
3. **The AI intern** (`ai-intern/`, optional) — enriches PR reports and writes ticket briefs.
   With the default **Local AI** backend it needs no key at all (Ollama runs in Docker). A
   **Cloud AI** backend needs one key: `CURSOR_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`.

MCP servers are **optional**. They matter only for the agent CLI the shell runners fall back to
when the deterministic Python fetch fails (`connector` in the config); Docker never uses them.

---

## Step 1 — Create your secrets file (required)

```bash
mkdir -p ~/.cursor
cp setup/mcp-secrets.env.template ~/.cursor/mcp-secrets.env
chmod 600 ~/.cursor/mcp-secrets.env      # readable only by you
```

Open `~/.cursor/mcp-secrets.env` and set at least:

```
JIRA_URL=https://jira.your-company.example
JIRA_PERSONAL_TOKEN=<paste your Jira Personal Access Token>
```

**Where the Jira token comes from:** Jira → your avatar → **Profile** → **Personal Access
Tokens** → **Create token**. Copy it immediately (you can't see it again). Read scope is enough.

Optional, for richer cards: `CONFLUENCE_PERSONAL_TOKEN`, `BITBUCKET_PAT` (or `ATLASSIAN_TOKEN`).
Optional, for Cloud AI: `CURSOR_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`. Optional proof
sources for the AI worker: `CHECKMARX_API_KEY`, `DYNATRACE_PAT`. Only these names are ever read
(see [`../docs/SECURITY.md`](../docs/SECURITY.md#secrets-read)); anything else you keep in the file
for other tools stays there. Point elsewhere with `AGENT_SECRETS=/path/to/file` (the MCP wrapper
uses `MCP_SECRETS_FILE`).

## Step 2 — Create a personal override (required for real identity/URLs)

Complete non-secret defaults live in `config/jira-board.config.json` — placeholders only, tracked
in git. Your sparse override holds just identity, company URLs and personal branding, outside git:

```bash
mkdir -p ~/.ai
cp setup/config.example.json ~/.ai/config.json
chmod 600 ~/.ai/config.json
```

Edit `~/.ai/config.json` and set your `user` (name as Jira shows it, your `accountId`, your
email), your `endpoints` (company URLs), and the `app.branding` footer. Full reference for every
key: [`../jira-intern/CONFIG.md`](../jira-intern/CONFIG.md).

The project config is loaded first. `$AI_CONFIG_FILE` or `~/.ai/config.json` is then
deep-merged over it, and saved Settings choices (`jira-intern/.settings.json`) are the final
runtime overlay. Confirm what's actually in effect, and that it validates:

```bash
node jira-intern/local-runner/config.mjs path
npm run config:validate
```

> Docker mounts `~/.ai` read-only into the containers, so it resolves the same way there. Create
> the file **before** your first `docker compose up` — if the path is missing, Docker creates a
> stray directory in its place.

## Step 3 — Private corporate CA (only if Jira uses one)

TLS verification is **on** for every Jira/Bitbucket call. If your Jira is signed by an internal
CA, the first fetch fails with a certificate error. Export the root CA as PEM (from your browser
or keychain, or ask IT) and:

- **Docker:** uncomment the `private-ca.pem` volume line in **both** `jira-board` and `jira-ai`
  in `docker-compose.yml`, then
  `JIRA_CA_BUNDLE_HOST=/path/to/root-ca.pem JIRA_CA_BUNDLE=/etc/ssl/private-ca.pem docker compose up -d`.
- **Host runs:** `export JIRA_CA_BUNDLE=/path/to/root-ca.pem` before `run-intern.sh` /
  `npm run serve` (or add the line to `~/.cursor/mcp-secrets.env`).

`JIRA_INSECURE_TLS=1` disables verification entirely and logs a warning on every run — a last
resort for a one-off test, not a configuration.

## Step 4 — Configure MCP servers (optional)

Only if you want the **agent fallback** (the Cursor / Claude / Codex CLI that the shell runners
call when the Python fetch fails) to reach Jira, Confluence and Bitbucket. Pick the client you use:

- **Cursor:** merge [`mcp.cursor.json.template`](mcp.cursor.json.template) into `~/.cursor/mcp.json`.
- **Claude Code / Desktop:** merge [`mcp.claude.json.template`](mcp.claude.json.template) into
  `~/.claude/.claude.json`.

Both templates point commands at the wrapper, which exports the secrets file and then execs the
real server so tokens never sit in JSON:

```bash
mkdir -p ~/.local/bin
cp setup/mcp-with-secrets.sh.template ~/.local/bin/mcp-with-secrets.sh
chmod +x ~/.local/bin/mcp-with-secrets.sh
```

The Atlassian MCP server used above is the community [`mcp-atlassian`](https://pypi.org/project/mcp-atlassian/)
(`pipx install mcp-atlassian`). Point each server's URL at your host; drop the `*_SSL_VERIFY=false`
lines unless your company uses a private CA (and prefer pointing the server at the CA bundle).

## Step 5 — Set the connector API key (optional)

The agent fallback runs through a CLI (`config → connector.active`, default `cursor`). Add its
key to your secrets file — `CURSOR_API_KEY` (or `ANTHROPIC_API_KEY` for `claude`,
`OPENAI_API_KEY` for `codex`). Not needed for Docker deployment, and separate from the AI-Intern
keys in Step 1 (the worker never uses a CLI).

## Step 6 — The Desktop launcher (optional, macOS)

```bash
cp "setup/Start Jira Board.command.template" ~/Desktop/"Start Jira Board.command"
# edit REPO_DIR inside it to your clone path, then:
chmod +x ~/Desktop/"Start Jira Board.command"
```

Double-click it to build + deploy in Docker and open the board. See
[`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) for all the ways to run it.

---

## Before you make the repo public

This repo is safe to push **as long as your real secrets never enter it** — they don't, by
design (tokens live only in `~/.cursor/mcp-secrets.env`, which is git-ignored, and so are
`jira-intern/data.*`, `reports/`, `.settings.json` and every other runtime file). Work through
this list first:

1. **No secrets file staged.** `git status` should never show `mcp-secrets.env` or any `*.env`
   with real values. The root `.gitignore` already blocks these.
2. **Keep `config/jira-board.config.json` generic.** It is intentionally tracked and must
   contain placeholders/defaults only. Real identity and internal URLs belong in the
   untracked `~/.ai/config.json` override.
3. **No company names, hostnames, tenant ids or project keys in the tree.** Docs and tests use
   neutral placeholders (`PROJ-123`, `jira.your-company.example`); keep it that way.
4. **Check git history, not just the current tree.** Early commits of a personal repo often
   contain internal hostnames or ids that were later replaced. Before publishing, either rewrite
   history (for example with `git filter-repo --replace-text`) or publish from a fresh-history
   mirror (`git checkout --orphan` + one initial commit). A clean `git grep` on `HEAD` says
   nothing about older commits.

A quick pre-push scan of the current tree for anything token- or hostname-shaped (add your own
company domain and project keys to the second pattern):

```bash
# token-shaped values
git grep -nIiE '(personal_token|api[_-]?key|pat|secret)\s*[=:]\s*[A-Za-z0-9]{12,}' -- . ':!setup' ':!*.md'
# internal hostnames / tenant ids — extend the alternation with your company's names
git grep -nIiE 'https?://[a-z0-9.-]+\.(corp|internal|intranet|lan|local)\b|your-company\.com|[a-z]{3}[0-9]{5}\.(apps|live)\.dynatrace' -- . ':!setup/*.template'
# the same patterns across history
git log -p --all -S'your-company' --oneline | head
```
