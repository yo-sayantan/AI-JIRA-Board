# Contributing

Small, focused changes with the docs and tests that go with them. This page is the dev loop, the
contracts that must move together, and recipes for the common changes.

## Dev loop

Requirements: Node **22.12+** (`.nvmrc` → 26), Python **3.11+**, Docker only for the image smoke
test. No Python packages are needed — the pipeline is standard library only.

```bash
npm install
npm run dev              # Vite on localhost:5173 with the SAMPLE fixture (src/fixtures.ts) — every UI state, no Jira
npm run serve            # the real server on 4321 against jira-intern/data.json (run a fetch first)
npm run typecheck        # tsc --noEmit
npm run build            # tsc --noEmit && vite build → dist/index.html
npm test                 # Python suite (tests/) + vitest suite
npm run test:py          # python3 -m unittest discover -s tests -p 'test_*.py'
npm run test:js          # vitest run
npm run config:validate  # schema-check config/jira-board.config.json (+ your ~/.ai/config.json)
bash -n jira-intern/local-runner/*.sh docker-entrypoint.sh start-jira-board.sh   # shell syntax
python3 -m py_compile jira-intern/*.py ai-intern/worker.py                       # Python syntax
```

To test the fetch against a real Jira you need `~/.cursor/mcp-secrets.env` and `~/.ai/config.json`
as described in [`../setup/README.md`](../setup/README.md); `python3 jira-intern/daily_fetch.py`
runs the fast path alone and prints a JSON summary. To test the worker without Docker:
`INTERN_DIR=$PWD/jira-intern OLLAMA_HOST=http://127.0.0.1:11434 python3 ai-intern/worker.py`
(needs Ollama on the host) and `AI_INTERN_URL=http://127.0.0.1:4322 npm run serve`.

CI (`.github/workflows/ci.yml`) runs, on Node 26 / Python 3.11: shellcheck (`-S error`) over the
entrypoint, launchers and runner scripts; `config:validate`; `npm test`; `typecheck`; `build`
(uploads `dist/index.html`); and `docker build` as a smoke test. Reproduce locally with the
commands above.

## Tests

- **Python** (`tests/test_*.py`, `unittest`, no network): `test_jira_http.py` (retry policy,
  pagination, TLS switches, formatters), `test_daily_fetch.py` (update log, "is mine", status
  columns, Bitbucket hints, main flow, single-key refresh), `test_archive.py` (full rebuild keeps
  prior rows, `mine` flags, scopes), `test_datafile.py` (Node parity of `data.js`, atomic write,
  the data lock), `test_config_helpers.py` (hints, proof endpoints, day stamps),
  `test_config.py` (Node ↔ Python config parity), `test_sprint.py`. Patch `urllib` / the module
  functions; never call a real Jira.
- **TypeScript** (`vitest`, jsdom): put `*.test.ts(x)` next to the module under `src/`. Pure
  helpers (`src/lib/*`) are the sweet spot — `columns.ts`, `format.ts`, `search.ts`,
  `settings.ts parseSettings`, `boardView.ts`.
- A behaviour change in the pipeline, the server or a contract needs a test in the matching suite.

## The three keep-in-sync contracts

| Contract | Side A | Side B | What must agree |
|---|---|---|---|
| **Ticket shape** | `src/types.ts` (`Ticket`, `CompletedTicket`, `JiraData`, `PullRequest`, …) | `jira-intern/prompts/intern-prompt.md` (the schema in prose for the agent fallback) and the Python builders in `daily_fetch.py` / `completed_archive.py` | Field names, enums (`ColumnKey`, `PrState`), what is optional. A new field is added in the type, produced by Python, described in the prompt, and consumed by the UI. |
| **Report shape** | `src/lib/reportTypes.ts` (block kinds, tones, provenance, verdict ids) | `jira-intern/pr_report.py` (`BLOCK_KINDS`, `TONES`, `validate_report`, `preserved_errors`) and `ai-intern/worker.py merge_enrichment` | A block kind or tone unknown to either side is rejected by `validate_report` or rendered as nothing. |
| **Column mapping** | `src/lib/columns.ts` (`BOARD_COLUMNS[].statuses`, `HOLD_COLUMN`, `mapStatusToColumn`) | `jira-intern/_jira.py` (`_STATUS_COLUMNS`, `status_column`) | The alias lists and the word-fallback order (qa → review → progress). The intern decides `column`; TS is the fallback for dumps without it. The only intended difference: an unknown status is *In Progress* in Python and *To Do* in TS. `tests/test_daily_fetch.py StatusColumns` covers the Python side; mirror additions in a vitest for `columns.ts`. |

Two more pairs are worth knowing: `jira-intern/_config.py` mirrors `local-runner/config.mjs`
(deep-merge and resolution order; `tests/test_config.py` enforces parity), and `datafile.py`
mirrors `sync-datajs.mjs` byte for byte (`tests/test_datafile.py NodeParity`). The lock rules in
`lock-util.sh` and `server/locks.mjs` must stay identical too.

## Recipes

**Add a Jira status alias to a column.** Add the lower-cased status to the column's tuple in
`_jira.py _STATUS_COLUMNS` *and* to the same column's `statuses` in `src/lib/columns.ts`. Add a
case to `tests/test_daily_fetch.py StatusColumns`. If it is a brand-new column (rare): extend
`ColumnKey` in `src/types.ts`, `BOARD_COLUMNS`, the Python tuple, the prompt's `column` enum,
`boardView.ts`, and the chips in `src/components/board/Stats.tsx`.

**Add a feature switch.** Append one entry to `FEATURES` in `src/lib/settings.ts` (key, default,
label, hint, detail). TypeScript will then demand its colour/icon in the exhaustive map in
`src/components/settings/Settings.tsx`. Read it as `settings.features.<key>` where the feature is
rendered (see `App.tsx`). Add the default to `config/jira-board.config.json →
app.settingsDefaults.features` and its schema. Document it in `docs/USAGE.md → Settings`.

**Add a server-synced setting.** Add the field to `Settings` and `SERVER_FIELDS` in
`src/lib/settings.ts` (parser + limits), to `SCHEMA` and the defaults in `server/settings.mjs`,
and — if a runner or the worker reads it — to `config.mjs shellenv` / `ai_queue.load_settings`.
Route it to the right section in `Settings.tsx`. Document in `docs/API.md` (settings fields) and
`docs/USAGE.md`.

**Add a report block kind.** Add the kind to `BLOCK_KINDS` in `pr_report.py` and the union in
`src/lib/reportTypes.ts`; render it generically in `src/components/reports/PrReport.tsx` (and the
print view). If the AI may emit it, extend `merge_enrichment` in `worker.py` and the JSON shape in
`ai-intern/prompts/enrich.txt`, and keep `preserved_errors` strict (AI adds, never changes).
Update the reference spec `jira-intern/prompts/pr-readiness-prompt.md` so the three stay aligned.

**Add a local model.** Append an object to `ai-intern/models.json` (see its `howto` field: `id`
must equal the Ollama tag you will pull or create; `level` low/moderate/full; `fits` container/host;
`ramGb`; links). The file is bind-mounted into AI-Intern, so `docker compose restart jira-ai` is
enough; the Settings dropdown and the offline guide read it. For a **cloud** model on Cursor there is
nothing to add in code: a model is offered when it is in the API key's Cursor catalog and priced at
or under $10 per 1M output tokens in `ai-intern/cursor-prices.json` (the whole
`cursor.com/docs/models-and-pricing` table). To add or re-price one, edit that file — one row with
`name`, `provider`, the four rates and `fast`; the worker picks it up on the next catalog fetch, and
the Settings list, the cache-read tile and the guide's price table all follow. Two name lists shape
the result: `exclude` hides a model you never want offered, and `include` offers one above the cap
(an exception). Models priced at $10 or more output get a ⚠ in the dropdown, the tile and the guide. Matching ignores
punctuation and case (`claude-sonnet-5-5` = `claude-sonnet-5.5` = "Claude Sonnet 5.5"), see
`ai-intern/cursor_prices.py`. If a model you expect is missing, hover the key strip in Settings: it
says how many were hidden as over the cap and lists catalog ids with no price on file. Claude and
Gemini lists are filtered by name (`_cheap_rank`, `_gemini_keep`).

**Add a server route.** Add the handler to `routes` in `serve.mjs` (or the prefix branch for
path parameters), validate inputs with the regexes in `server/config.mjs`, add it to
`JSON_BODY_ROUTES` if it takes a body, update the header comment in `serve.mjs` **and**
`docs/API.md`, and wire the client in `src/lib/runner.ts`.

**Add a runtime file or lock.** Register it in `server/config.mjs PATHS`, `.gitignore`,
`.dockerignore`, and `docs/RUNTIME-FILES.md`. A new data writer must take the shared locks
through `runner-env.sh` (`refuse_if_locked` / `acquire_lock_or_exit`) and `datafile.data_lock`.

**Change behaviour at all.** Find the sentence in `docs/` that describes the old behaviour and
change it in the same PR (`DEPLOYMENT.md`, `USAGE.md`, `ARCHITECTURE.md`, `API.md`,
`RUNTIME-FILES.md`, `SECURITY.md`, the offline guide `docs/index.html`, `jira-intern/CONFIG.md`
for config keys). Add a line to `docs/CHANGELOG.md`.

## Style

- TypeScript: strict, no `any` in new code, named exports, small pure helpers in `src/lib/`,
  hooks own side effects, components compose. Tailwind utilities with the CSS variables in
  `src/styles/`; motion through `motion/react`, respecting `features.animations`.
- Python: standard library only, no network in tests, `atomic_write` / `write_outputs` for every
  file the board reads, locks around `data.json`, exit codes from
  [`RUNTIME-FILES.md`](RUNTIME-FILES.md#exit-codes).
- Shell: `set -o pipefail`, no `eval` on data, argument arrays, `shellcheck -S error` clean,
  LF line endings (`.gitattributes`).
- Node server: zero dependencies, validate before spawn, argument arrays, bounded bodies and queues.
- Docs: GitHub-flavoured Markdown only; neutral placeholders (`PROJ-123`,
  `jira.your-company.example`); every `.md` guide lives under `docs/` (README and LICENSE at root).

## Pull request checklist

Copy of `.github/pull_request_template.md`:

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds (the single-file `dist/index.html`)
- [ ] `npm test` passes (Python + vitest); new behaviour has a test
- [ ] `npm run config:validate` passes if `config/` changed; `shellcheck -S error` if a `.sh` changed
- [ ] Docs updated for any behaviour change (`docs/`, `setup/`, `README.md`, `jira-intern/CONFIG.md`) and a `CHANGELOG.md` line added
- [ ] The keep-in-sync contracts above still agree
- [ ] No secrets, tokens, real ticket content, company names, internal hostnames, tenant ids or project keys in the diff
- [ ] No runtime files staged (`jira-intern/data.*`, `reports/`, `.settings.json`, `logs/`, `cache/`)
