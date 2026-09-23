# Deployment & running

Three ways to run the board, easiest first. All of them assume you've done the one-time
[setup](../setup/README.md) (a Jira token in `~/.cursor/mcp-secrets.env` and a filled-in
optional personal override at `~/.ai/config.json`; project defaults are in
`config/jira-board.config.json`).

---

## Option A — Docker (recommended)

Self-contained: builds the app, runs the fetch on start, auto-refreshes every 15 minutes, and
serves the board. Nothing to install but Docker.

### One command

```bash
docker compose up -d --build
```

Then open **http://localhost:4321/dist/index.html**.

### What that does

`docker-compose.yml` builds the board image and starts **JIRA-Board**, **JIRA-AI-Ollama**, and
**JIRA-AI-Intern**:

- Mounts `~/.cursor` read-only (so `mcp-secrets.env` stays readable after the file is replaced).
- Reads refresh startup/interval policy from `config/jira-board.config.json → refresh`
  (`REFRESH_ON_START` / `REFRESH_INTERVAL` can still override it).
- Persists data on the host via the `./jira-intern` volume; models on `jira-ai-models`.

### Everyday commands

```bash
docker compose logs -f            # watch fetch + server logs
docker compose down               # stop
docker compose up -d --build      # rebuild + redeploy after a code change
```

> **After changing any code in `src/`** you must rebuild (`--build`) — the app is baked into the
> image at build time. Changing only *data* does not need a rebuild; the container refetches.

### macOS: the double-click launcher

`start-jira-board.sh` wraps all of this: it starts Docker if needed, frees the fixed port,
rebuilds, redeploys the same container on the same port, waits for health, and opens the board.
Clicking it repeatedly is always safe.

```bash
./start-jira-board.sh
```

To make it a Desktop shortcut, use [`setup/Start Jira Board.command.template`](../setup/Start%20Jira%20Board.command.template).

---

## Option B — Static file (no server at all)

The production build is a single self-contained `dist/index.html`. If a data dump already exists
(`jira-intern/data.js`), just open it:

```bash
open dist/index.html          # macOS — or double-click "Open Board.html"
```

It reads the last dump straight off `file://`. The header's **Reload** button (or press `r`)
re-reads the latest `data.js`. To refresh the *data*, run a fetch in a terminal
(`bash jira-intern/local-runner/run-intern.sh`) — you never rebuild the app to see new data.

To produce `dist/index.html` yourself:

```bash
npm install
npm run build                 # → dist/index.html (single file, JS/CSS inlined)
```

---

## Option C — Live local server

Turns the header button into a real **Refresh** that runs the fetch on your machine, shows a
spinner, and reloads when fresh data lands.

```bash
npm run serve                 # prints http://localhost:4321/dist/index.html
```

If a run is already going (even one you started in a terminal), the button reattaches to it;
refresh the page mid-run and it reconnects instead of looking idle.

---

## Refreshing the data by hand

```bash
bash jira-intern/local-runner/run-intern.sh        # active tickets (daily)
bash jira-intern/local-runner/update-completed.sh  # full Completed archive (weekly)
```

Both rewrite `jira-intern/data.json` + `data.js`; reload the board to see the result.

## PR Readiness Reports

Generated automatically in the background after each fetch (see `config/jira-board.config.json → reports`). By hand:

```bash
bash jira-intern/local-runner/pr-report.sh FRAUDBUSTE-290           # one ticket (base + AI enrichment)
bash jira-intern/local-runner/pr-reports-backfill.sh --year 2026    # every 2026 ticket that has a PR
bash jira-intern/local-runner/pr-reports-backfill.sh --no-ai        # deterministic only — fast, no agent
bash jira-intern/local-runner/pr-reports-backfill.sh --force        # rebuild even if current
```

Output: `jira-intern/reports/<KEY>.json` (+ `reports/index.js` for `file://`). **Git-ignored** — real
PR/Jira content never leaves the machine. Docker writes the deterministic base in JIRA-Board, then
enqueues enrichment for JIRA-AI-Intern when Settings is not None. Download a local model from
Settings, or `docker exec JIRA-AI-Ollama ollama pull qwen2.5-coder:7b`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Board loads but is empty | No dump yet. Run a fetch (Option A refetches on boot; or run `run-intern.sh`). |
| "no JIRA_PERSONAL_TOKEN found — skipping fetch" | Your secrets file isn't mounted/readable. Check `~/.cursor/mcp-secrets.env` exists and has `JIRA_PERSONAL_TOKEN`. |
| Port 4321 in use | `start-jira-board.sh` frees it automatically; otherwise `docker compose down` or stop the process on that port. |
| `Name or service not known` for your Jira host | Docker DNS (common on VPN). Uncomment the `dns:` block in `docker-compose.yml` and recreate. |
| Container exits immediately | `docker logs JIRA-Board` — usually a bad token or unreachable host. |
| Changed `src/` but UI looks old | Rebuild the image: `docker compose up -d --build`. |
