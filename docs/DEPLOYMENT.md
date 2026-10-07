# Deployment & running

Three ways to run the board, easiest first. All of them assume you've done the one-time
[setup](../setup/README.md): a Jira token in `~/.cursor/mcp-secrets.env` and, for your real
identity and URLs, a sparse personal override at `~/.ai/config.json` (project defaults live in
`config/jira-board.config.json`).

---

## Option A — Docker (recommended)

Self-contained: builds the app, fetches once on start, serves the board, and refreshes on the
cadence you choose in Settings. Nothing to install but Docker.

### One command

```bash
docker compose up -d --build                 # board + AI-Intern + AI-Ollama (all three)
docker compose up -d --build jira-board      # board only — the AI pair is optional
```

Then open **http://localhost:4321/dist/index.html**.

### What that starts

`docker-compose.yml` (Compose project `jira-project`, shown as **JIRA-Project** in Docker
Desktop) defines three services:

| Service | Container | What it does |
|---|---|---|
| `jira-board` | **JIRA-Board** | The Node server + the Python fetch pipeline. The only published port. |
| `ollama` | **AI-Ollama** | Local inference. Models persist on the named volume `jira-board_jira-ai-models`, created automatically. |
| `jira-ai` | **AI-Intern** | The queue worker that enriches PR reports and writes ticket briefs (local Ollama, or a cloud API with your key). Reached only through the board's `/api/ai-*` proxy. |

Without the AI pair the board still works: Settings shows "AI intern offline" and PR reports stay
deterministic. All three use `restart: unless-stopped`, so after the first `up` they come back
whenever Docker starts.

Mounts (the board runs as the unprivileged `node` user, uid 1000, `HOME=/home/node`):

| Host | In JIRA-Board | In AI-Intern | Why |
|---|---|---|---|
| `~/.cursor/` | `/home/node/.cursor` (ro) | `/root/.cursor` (ro) | `mcp-secrets.env`. The **directory** is mounted, not the file — a single-file bind keeps pointing at the old inode after an editor rewrites it. |
| `~/.ai/` | `/home/node/.ai` (ro) | `/root/.ai` (ro) | `config.json`, your sparse personal override. Create it **before** the first `up`, or Docker creates a stray directory in its place. |
| `./config/` | `/app/config` (ro) | `/app/config` (ro) | Tracked project defaults + schema. |
| `./jira-intern/` | `/app/jira-intern` (rw) | `/app/jira-intern` (rw) | Fetched data, reports, queue, locks, logs — shared by both containers. |

> **Linux hosts:** the bind-mounted `./jira-intern` must be writable by uid 1000:
> `sudo chown -R 1000:1000 ./jira-intern` once. Docker Desktop (macOS/Windows) handles this
> transparently. If the entrypoint logs `could not seed /app/jira-intern`, this is why.

### Refresh cadence

- **On boot:** exactly one fetch of active tickets (`REFRESH_ON_START`, default from
  `config → refresh.onStart = true`), run through the locked `run-intern.sh`. If no Jira token is
  reachable it logs `no JIRA_PERSONAL_TOKEN found — skipping fetch` and serves the last saved data.
- **Afterwards:** the board server's scheduler (`server/schedule.mjs`) owns every repeat run, from
  **Settings → Background jobs**: *Active tickets* (default twice-daily), *Whole board* — active
  tickets then the Completed archive (default twice-weekly), *PR reports* (default twice-weekly).
  Set any of them to **off** to stop it. There is **no fixed interval** and no `REFRESH_INTERVAL`.
- **On demand:** the header **Refresh board** button, the trophy menu (archive), the sparkle menu
  (reports), and the per-ticket refresh in the drawer.

### Ports, LAN access and the Host header

The board is published on **127.0.0.1 only** by default — reachable from this machine, invisible
to the network. To use it from another device:

```bash
BIND_IP=0.0.0.0 ALLOWED_HOSTS=my-laptop.local,192.168.1.20 docker compose up -d
```

`ALLOWED_HOSTS` is required: the server answers only to loopback names, its own bind address, or
the comma-separated `host[:port]` entries you list, and returns **403 `forbidden host`** for
anything else (this is what stops a malicious web page from DNS-rebinding onto your board).
`PORT=8080 docker compose up -d --build` moves the host port.

### TLS to Jira / Bitbucket

Certificate verification is **on** by default for every call the fetch and the AI worker make. If
your Jira sits behind a private corporate CA you will see a certificate error until you tell the
containers about it:

```bash
# 1. uncomment the private-ca volume line in BOTH services of docker-compose.yml, then:
JIRA_CA_BUNDLE_HOST=/path/to/your-root-ca.pem JIRA_CA_BUNDLE=/etc/ssl/private-ca.pem docker compose up -d
```

`JIRA_INSECURE_TLS=1` switches verification off entirely — last resort only; every run then prints
`WARN: TLS verification disabled`. Details: [SECURITY.md → TLS](SECURITY.md#tls-posture).

### Environment knobs

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4321` | Host port the board is published on. |
| `BIND_IP` | `127.0.0.1` | Host interface the port is published on. |
| `ALLOWED_HOSTS` | *(empty)* | Extra `host[:port]` names the server accepts when not reached via loopback. |
| `REFRESH_ON_START` | config `refresh.onStart` (`true`) | Fetch once when the container boots. |
| `JIRA_CA_BUNDLE` / `JIRA_INSECURE_TLS` | *(unset)* | Private CA bundle path / disable verification (see above). |
| `JIRA_PERSONAL_TOKEN` etc. | from `mcp-secrets.env` | Any secret may also be passed with `-e`; an explicit environment value wins over the file. |
| `AI_INTERN_URL` | `http://jira-ai:4322` | Where the board proxies AI status, jobs and model pulls. |
| `CHECKMARX_BASE_URL` / `CHECKMARX_AUTH_URL` / `DYNATRACE_TENANTS` | *(unset)* | Optional proof endpoints for the AI worker (or set `endpoints.*` in config). |

Every variable the Python scripts read: [`../jira-intern/CONFIG.md`](../jira-intern/CONFIG.md#environment-variables-read-by-the-python-fetch-scripts).

### Everyday commands

```bash
docker compose logs -f            # watch fetch + server logs (all three containers)
docker compose logs -f jira-ai    # just the AI worker
docker compose ps                 # health: JIRA-Board and AI-Intern report healthy/unhealthy
docker compose down               # stop
docker compose up -d --build      # rebuild + redeploy after a code change
docker compose restart jira-ai    # after editing ai-intern/models.json (bind-mounted, no rebuild)
```

> **After changing any code in `src/`, `server/`, `serve.mjs` or `jira-intern/*.py`** rebuild
> with `--build` — they are baked into the image (the bind-mounted `./jira-intern` seeds from the
> image only when empty). Changing only *data* never needs a rebuild.

### macOS: the double-click launcher

`start-jira-board.sh` wraps all of this: starts Docker if needed, frees the fixed port (removing
stale containers from older deploys), rebuilds **without re-pulling base images** (`PULL=1` to
force a pull — Docker Hub can be slow), redeploys on the same port, waits for health, and opens
the board. Clicking it repeatedly is always safe.

```bash
./start-jira-board.sh
PULL=1 PORT=4321 ./start-jira-board.sh
```

To make it a Desktop shortcut, use [`setup/Start Jira Board.command.template`](../setup/Start%20Jira%20Board.command.template).

### Local AI models

Settings → AI → **Local AI** lists the catalogue from `ai-intern/models.json`; the download icon
queues an Ollama pull inside **AI-Ollama**. Tick **Host Ollama · Metal** to use an Ollama running
on the host (`host.docker.internal:11434`) instead — much faster on Apple Silicon. From a terminal:
`docker exec AI-Ollama ollama pull qwen2.5-coder:7b`. The offline guide ([index.html](index.html))
covers GGUF files and registering a tag by hand.

---

## Option B — Static file (no server at all)

The production build is a single self-contained `dist/index.html`. If a data dump already exists
(`jira-intern/data.js`), just open it:

```bash
open dist/index.html          # macOS — or double-click "Open Board.html"
```

It reads the last dump straight off `file://`. The header's **Reload** button (or `r`) re-reads
the latest `data.js`; PR reports come from `jira-intern/reports/index.js`. To refresh the *data*,
run a fetch in a terminal (below) — you never rebuild the app to see new data. Settings are saved
in the browser only.

To produce `dist/index.html` yourself (Node 22.12+):

```bash
npm install
npm run build                 # → dist/index.html (single file, JS/CSS inlined)
```

---

## Option C — Live local server

Turns the header button into a real **Refresh** that runs the fetch on your machine, shows a
spinner, and swaps in fresh data when it lands. Also enables the archive and report menus,
per-ticket refresh, Settings sync and the scheduler.

```bash
npm run serve                 # prints http://localhost:4321/dist/index.html
```

Needs Node 22.12+ and Python 3.11+ on the host. Listens on `127.0.0.1` (set `BIND_HOST` and
`ALLOWED_HOSTS` to change that). If a run is already going (even one you started in a terminal),
the button reattaches to it. AI features need AI-Intern reachable at `AI_INTERN_URL`
(default `http://127.0.0.1:4322`); compose does not publish that port, so either run the worker
on the host (`INTERN_DIR=$PWD/jira-intern OLLAMA_HOST=http://127.0.0.1:11434 python3
ai-intern/worker.py`, with Ollama installed locally) or add a `ports:` entry for `jira-ai` in a
compose override. Without it the board simply shows "AI intern offline".

---

## Refreshing the data by hand

```bash
bash jira-intern/local-runner/run-intern.sh                 # active tickets
bash jira-intern/local-runner/update-completed.sh           # the whole Completed archive
ARCHIVE_SCOPE=year ARCHIVE_YEAR=2025 bash jira-intern/local-runner/update-completed.sh   # one slice
bash jira-intern/local-runner/refresh-ticket.sh PROJ-123    # one ticket
```

All of them rewrite `jira-intern/data.json` + `data.js` under the shared locks; a run that finds
another writer active exits 3 and does nothing. Exit codes and where the logs go:
[RUNTIME-FILES.md](RUNTIME-FILES.md).

## PR Readiness Reports

Generated automatically in the background after each fetch for tickets whose PR appeared or
changed (`config → reports.autoGenerate`, capped by `reports.maxPerRun`), after a single-ticket
refresh, from the drawer button, from the header sparkle menu, and by the scheduler. By hand:

```bash
bash jira-intern/local-runner/pr-report.sh PROJ-123                 # one ticket: base, then AI enrichment
bash jira-intern/local-runner/pr-report.sh PROJ-123 --if-needed     # skip when the stored report is current
bash jira-intern/local-runner/pr-report.sh PROJ-123 --no-ai         # deterministic base only

bash jira-intern/local-runner/pr-reports-backfill.sh                # every ticket with a PR in config.reports.year
bash jira-intern/local-runner/pr-reports-backfill.sh --year 2025    # a different year
bash jira-intern/local-runner/pr-reports-backfill.sh --all-years
bash jira-intern/local-runner/pr-reports-backfill.sh --force        # regenerate even if current
bash jira-intern/local-runner/pr-reports-backfill.sh --needs-ai     # only reports still deterministic-only (resume an AI pass)
bash jira-intern/local-runner/pr-reports-backfill.sh --no-ai        # bases only — fast, no AI
bash jira-intern/local-runner/pr-reports-backfill.sh --max 10       # cap this pass
bash jira-intern/local-runner/pr-reports-backfill.sh --auto         # what run-intern.sh launches: honours autoGenerate + maxPerRun
```

Output: `jira-intern/reports/<KEY>.json` (+ `reports/index.js` for `file://`). **Git-ignored** —
real PR/Jira content never leaves the machine unless you choose a cloud AI backend. The base is
written by the board or the script; enrichment is queued for **AI-Intern** unless Settings → AI is
**None**.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Board loads but is empty | No dump yet. Wait for the boot fetch (`docker compose logs -f jira-board`) or run `run-intern.sh`. |
| `no JIRA_PERSONAL_TOKEN found — skipping fetch` | The secrets file isn't mounted or has no token line. Check `~/.cursor/mcp-secrets.env` exists and contains `JIRA_PERSONAL_TOKEN=…`. |
| `403 {"error":"forbidden host"}` | You opened the board under a name that isn't loopback. Add it: `ALLOWED_HOSTS=<host[:port]>`. |
| `CERTIFICATE_VERIFY_FAILED` / `certificate verify failed` in the fetch log | Private corporate CA. Mount it and set `JIRA_CA_BUNDLE` (see TLS above). |
| `could not seed /app/jira-intern` / `Permission denied` on Linux | `sudo chown -R 1000:1000 ./jira-intern` — the board runs as uid 1000. |
| Settings shows "AI intern offline" | The `jira-ai` service isn't running (`docker compose up -d jira-ai`) or isn't healthy (`docker compose logs jira-ai`). The board itself is unaffected. |
| Refresh says "another refresh/archive was already running" | Exit 3: a lock is held. Wait for the job, or see [RUNTIME-FILES.md → Locks](RUNTIME-FILES.md#locks). |
| Port 4321 in use | `start-jira-board.sh` frees it automatically; otherwise `docker compose down` or stop the process, or `PORT=8080 …`. |
| `Name or service not known` for your Jira host | Docker DNS (common on VPN). Uncomment the `dns:` block in `docker-compose.yml` and recreate. |
| Container exits immediately | `docker logs JIRA-Board` — usually a bad token or an unreachable host. |
| Changed `src/` but UI looks old | Rebuild the image: `docker compose up -d --build`. |
| `~/.ai/config.json` became a directory | It didn't exist at first `up`. Remove the directory, create the file, recreate the container. |
