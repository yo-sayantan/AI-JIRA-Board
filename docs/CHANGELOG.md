# Changelog

Notable changes by area. Dates are omitted for the unreleased section; entries describe what the
code does now, so a reader can check them against the tree.

## Unreleased — primary branch

- A ticket with several branches now shows the one with the **newest commit** as its branch, and
  the PR banners (card badge, approvals, drawer badge) follow that branch's own PR instead of
  whichever PR was updated last. Other PRs stay listed and count toward `+N PR`. Commit times come
  from Bitbucket (`devinfo.py`), one call per branch and only for tickets with more than one; the
  previous choice is kept when Bitbucket cannot be reached. See
  [INTEGRATIONS.md](INTEGRATIONS.md#bitbucket-serverdc-rest-10--jira-dev-status).

## Unreleased — codebase audit

### Security

- TLS verification is **on by default** for every Jira / Bitbucket / cloud call
  (`jira-intern/_jira.py ssl_context()`, `ai-intern/worker.py _verified_ssl()`). Private CA via
  `JIRA_CA_BUNDLE` (compose has a commented mount); `JIRA_INSECURE_TLS=1` is the logged last resort.
- The board server rejects unknown `Host` headers with 403 (`ALLOWED_HOSTS` opt-in) to block DNS
  rebinding, checks `Origin`/`Referer`/`Sec-Fetch-Site` on every write, requires
  `Content-Type: application/json` on JSON routes, caps body sizes (413) and queue depth (429),
  supports `HEAD`, and sends `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`.
  Jira data (`data.json`, `data.js`, `reports/index.js`) is served `Cache-Control: no-store`.
- Compose publishes the board on `127.0.0.1` only by default (`BIND_IP` to change).
- The board image runs as the unprivileged `node` user (uid 1000); mounts moved to `/home/node`.
- Secrets are **parsed, never sourced** everywhere (`_config.load_secrets`, `runner-env.sh
  export_secrets_from_file`, the MCP wrapper template, the worker). The entrypoint no longer
  exports the secrets file into the Node server; the runners export an allow-list; the worker
  keeps cloud keys out of `os.environ`.
- Ticket keys, years, dates, archive scopes and model tags are validated on every path (server,
  `ai_queue.py`, runners, worker); children are spawned with argument arrays.
- Untrusted ticket/PR text is wrapped in `<untrusted_data>` for the model; AI output may only add
  to a report (`validate_report` + `preserved_errors`); failures restore the base atomically.
- `jira-intern/light_html` drops `javascript:`/`data:` links; `pr_report.py` escapes attributes.

### Robustness

- No fixed refresh loop: one fetch on boot through the locked runner, then `server/schedule.mjs`
  runs the cadences from Settings → Background jobs (`.schedule.json` seeded on start so a restart
  never repeats the boot fetch). `REFRESH_INTERVAL` and `SKIP_SUMMARY` are gone.
- Lock protocol unified between `lock-util.sh` and `server/locks.mjs`: one-line
  `<pid> <ISO> <hostname>` format, atomic `noclobber` acquisition, three staleness rules (dead
  PID; PID-less after 45 min; live PID until an 8 h ceiling; other-host PIDs ignored). The
  entrypoint clears locks left by a previous container. Python writers take an advisory `flock`
  on `.data.lock`.
- Exit codes are explicit: 2 configuration (no token — no LLM fallback), 3 locked, 4 partial
  archive (previous rows kept, runner exits 0 with a warning), 6 unrendered prompt, 124 timeout,
  127 agent CLI missing; a signal-killed child is reported as 1.
- Jira HTTP: 429 honours `Retry-After`; other 4xx fail fast; 5xx/network back off. Transient-DNS
  and VPN flaps no longer produce multi-page tracebacks.
- `data.json`/`data.js` are written atomically together (`datafile.write_outputs`), byte-identical
  to `sync-datajs.mjs`; a run that leaves `data.json` invalid restores the pre-run snapshot.
- The AI queue dedups against claimed jobs, requeues orphaned `.running` jobs on restart, and
  honours the `.ai-cancel-report` marker; `/health` turns 503 when a worker thread dies.
- Both images carry `HEALTHCHECK`s; `tini` is PID 1 in the board; the `jira-ai-models` volume is
  created automatically; `start-jira-board.sh` no longer re-pulls base images (`PULL=1`).
- `docker compose up jira-board` works without the AI pair (`required: false`); the board shows
  "AI intern offline".
- Node `>= 22.12` is declared in `package.json`; images and CI use Node 26 (`.nvmrc`).
- A React `ErrorBoundary` wraps the app; settings parsing validates every field and falls back to
  defaults.

### Features and configuration

- Optional proof rows for PR reports — Bitbucket build status (CI), Checkmarx, Dynatrace — are
  queried when `CHECKMARX_API_KEY` / `DYNATRACE_PAT` and `endpoints.checkmarxBase` /
  `checkmarxAuthUrl` / `dynatraceTenants` (or their env equivalents) are configured.
- New config keys `bitbucket.projectMap` and `bitbucket.repoHints` replace built-in repository
  names; both default to empty. `jira-intern/config.json` (dead) was deleted; the only config is
  `config/jira-board.config.json` plus the sparse `~/.ai/config.json` override.
- Won't fix / cancelled / rejected statuses map to Done on both sides of the column contract.
- Cursor cloud models are a curated allow-list (`_CURSOR_KEEP`); Claude lists Haiku, Gemini lists
  Flash/Lite.

### Tests and CI

- Python `unittest` suites under `tests/`: HTTP retry/pagination/TLS, daily fetch flow and
  single-key refresh, archive rebuild and scopes, `data.js` parity and atomic writes, data lock,
  config helpers and Node ↔ Python config parity, sprint fields. `npm test` runs them with the
  vitest suite (`npm run test:py` / `npm run test:js`).
- CI runs shellcheck, config validation, the tests, typecheck, the single-file build and a Docker
  build smoke test on every push and pull request.

### Documentation

- Every guide now lives under `docs/`: new `API.md`, `RUNTIME-FILES.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, `AGENTS.md`, `CHANGELOG.md`; `ARCHITECTURE.md`, `DEPLOYMENT.md`, `USAGE.md`,
  `index.html`, `README.md` and `setup/README.md` rewritten against the current code (three
  containers, loopback default, `BIND_IP`/`ALLOWED_HOSTS`, non-root mounts, TLS, cadence from
  Settings, backfill flags, Completed dialog, header menus, Settings sections, shortcuts).
- A 5-line root `CLAUDE.md` imports `docs/AGENTS.md`.
- `jira-intern/prompts/pr-readiness-prompt.md` and `intern-summary-prompt.md` are marked as
  reference specifications (the live prompt is `ai-intern/prompts/enrich.txt`);
  `intern-prompt.md` now states the 5-day "recent win" window (`app.doneBoardDays`).
- `setup/README.md` gained a private-CA step and a pre-publish checklist that covers git history.
- The PR template asks for passing tests and updated docs.
