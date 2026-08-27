# Setup — secrets, config & MCP

Everything user-, company- and token-specific lives **outside** the app bundle. This folder
holds a safe **template** for each of those files. Nothing here contains a real token — you
copy a template, fill it in on your machine, and keep your filled-in copies out of git.

> **The golden rule:** the only file that ever holds a real token is your
> `mcp-secrets.env`, and it lives **outside this repo** (default `~/.cursor/mcp-secrets.env`).
> Everything else points at it by path.

| Template in this folder | Copy it to | What it is |
|---|---|---|
| [`mcp-secrets.env.template`](mcp-secrets.env.template) | `~/.cursor/mcp-secrets.env` | Your API tokens (Jira required; Confluence/Bitbucket optional). |
| [`config.example.json`](config.example.json) | `~/.ai/config.json` | Who you are + your company URLs + preferences. **No tokens.** Lives outside the repo. |
| [`mcp.cursor.json.template`](mcp.cursor.json.template) | `~/.cursor/mcp.json` | MCP servers for Cursor (optional — richer AI briefs). |
| [`mcp.claude.json.template`](mcp.claude.json.template) | `~/.claude/.claude.json` | MCP servers for Claude Code (optional). |
| [`mcp-with-secrets.sh.template`](mcp-with-secrets.sh.template) | `~/.local/bin/mcp-with-secrets.sh` | Wrapper that keeps tokens out of the MCP JSON. |
| [`Start Jira Board.command.template`](Start%20Jira%20Board.command.template) | `~/Desktop/Start Jira Board.command` | macOS double-click launcher. |

---

## What you actually need

The board has **two moving parts**, and they need different things:

1. **The fetch** (`jira-intern/`) — pulls your tickets. Needs **one Jira token**. That's the
   only hard requirement. Confluence and Bitbucket tokens are optional and just add richer
   detail (linked docs, real branches, PR state).
2. **The app** (`src/` → `dist/index.html`) — renders whatever the fetch dumped. Needs **nothing**.

MCP servers are **optional**. They're only used by the local *AI-summary pass* that writes the
long ticket briefings. The Docker deployment runs `SKIP_SUMMARY=1` (a deterministic fetch, no
LLM), so **to just deploy the board you only need a Jira token** — skip steps 3–4 below.

---

## Step 1 — Create your secrets file (required)

```bash
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

Optional, for richer cards: `CONFLUENCE_PERSONAL_TOKEN`, `BITBUCKET_PAT` (see the template).

## Step 2 — Create your personal `config.json` (required)

This holds your identity and company URLs. It lives **outside the repo** so your real values
never enter git:

```bash
mkdir -p ~/.ai
cp setup/config.example.json ~/.ai/config.json
chmod 600 ~/.ai/config.json
```

Edit `~/.ai/config.json` and set your `user` (name **exactly** as Jira shows it, so
"assigned to me" matches), your `endpoints` (company URLs), and the `app.branding` footer.
Full reference for every key: [`../jira-intern/CONFIG.md`](../jira-intern/CONFIG.md).

**Which file wins**, first match:

1. `$AI_CONFIG_FILE` — explicit override, any path
2. `~/.ai/config.json` — **yours** (the one you just created)
3. `jira-intern/config.json` — the tracked template/fallback, placeholders only

Confirm what's actually in effect:

```bash
node jira-intern/local-runner/config.mjs path
```

> Docker mounts `~/.ai/config.json` read-only into the container, so it resolves the same way
> there. Create the file **before** your first `docker compose up` — if the path is missing,
> Docker creates a stray directory in its place.

## Step 3 — Configure MCP servers (optional)

Only if you want the **local AI-summary pass** to enrich tickets from Confluence/Bitbucket.
Pick the client you use:

- **Cursor:** merge [`mcp.cursor.json.template`](mcp.cursor.json.template) into `~/.cursor/mcp.json`.
- **Claude Code / Desktop:** merge [`mcp.claude.json.template`](mcp.claude.json.template) into
  `~/.claude/.claude.json`, and install the wrapper so tokens stay out of that JSON:
  ```bash
  cp setup/mcp-with-secrets.sh.template ~/.local/bin/mcp-with-secrets.sh
  chmod +x ~/.local/bin/mcp-with-secrets.sh
  ```

The Atlassian MCP server used above is the community [`mcp-atlassian`](https://pypi.org/project/mcp-atlassian/)
(`pipx install mcp-atlassian`). Point each server's URL at your host; drop the `*_SSL_VERIFY=false`
lines unless your company uses a private/internal certificate authority.

## Step 4 — Set the connector API key (optional)

The AI-summary pass runs through an agent CLI (`config.json → connector.active`, default
`cursor`). Add its key to your secrets file — e.g. `CURSOR_API_KEY=…` (or `ANTHROPIC_API_KEY`
for `claude`, `OPENAI_API_KEY` for `codex`). Not needed for Docker deployment.

## Step 5 — The Desktop launcher (optional, macOS)

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
design (tokens live only in `~/.cursor/mcp-secrets.env`, which is git-ignored). Two things to
double-check first:

1. **No secrets file staged.** `git status` should never show `mcp-secrets.env` or any `*.env`
   with real values. The root `.gitignore` already blocks these.
2. **Sanitize or untrack `jira-intern/config.json`.** It holds your name, corporate ID and
   internal hostnames — fine for a private repo, but for a **public** one either scrub those
   values or stop tracking the personalized copy and ship only the template:
   ```bash
   git rm --cached jira-intern/config.json
   echo "jira-intern/config.json" >> .gitignore
   git add setup/config.example.json      # the sanitized template ships instead
   ```

A quick pre-push scan for anything token-shaped:

```bash
git grep -niE '(personal_token|api[_-]?key|pat|secret)\s*[=:]\s*[A-Za-z0-9]{12,}' -- . ':!setup' ':!*.md'
```
